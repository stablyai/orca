import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  stageStartupCommand,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'
import { Session } from './session'
import {
  observeReturnedTerminalProcess,
  recoverUnpublishedTerminalSession,
  terminalSessionExitCode
} from './terminal-host-returned-process'
import { shellPathSupportsPtyStartupBarrier } from './shell-ready'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import { resolveDaemonSessionScrollbackRows } from './daemon-session-scrollback-window'
import { TerminalAttachCanceledError } from './daemon-errors'
import { recordSessionSpawnPaneKey } from './terminal-host-session-listing'
import {
  attachSessionInputViewer,
  isSessionInputClosed,
  trackSessionInput
} from './session-input-path'
import {
  createSessionExitHandler,
  isCwdReadableByThisProcess
} from './terminal-host-session-process'
import type { TerminalHostSessionCreateDependencies } from './terminal-host-session-create'
export async function spawnAndPublishSession(
  opts: InternalCreateOrAttachOptions,
  deps: TerminalHostSessionCreateDependencies,
  ctx: { size: { cols: number; rows: number }; wslDistro: string | undefined },
  onPublished: (sessionId: string, isAlive: boolean) => void
): Promise<CreateOrAttachResult> {
  const { size, wslDistro } = ctx
  // Only macOS needs the TCC probe; other hosts must not pin extra filesystem workers.
  const cwdReadableByDaemon =
    process.platform === 'darwin' && opts.cwd && !wslDistro
      ? await isCwdReadableByThisProcess(opts.cwd, opts)
      : null
  deps.assertCreateAllowed()
  const lower = Promise.withResolvers<PtyCreationDisposition>()
  opts.creationWork?.join(lower.promise)
  let lowerReported = false
  let physical: ReturnType<typeof observeReturnedTerminalProcess>
  let subprocess: SubprocessHandle
  try {
    subprocess = await deps.spawnSubprocess({
      onCreationDisposition: (disposition) => {
        lowerReported = true
        lower.resolve(disposition)
      },
      sessionId: opts.sessionId,
      cols: size.cols,
      rows: size.rows,
      cwd: opts.cwd,
      env: opts.env,
      envToDelete: opts.envToDelete,
      command: opts.command,
      startupCommandDelivery: opts.startupCommandDelivery,
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      shellOverride: opts.shellOverride,
      terminalShellArgs: opts.terminalShellArgs,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
      isCanceled: opts.isCanceled,
      assertCreateAllowed: deps.assertCreateAllowed,
      ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {})
    })
    // External implementations returning a handle have transferred an actual resource.
    physical = observeReturnedTerminalProcess(subprocess, opts.sessionId, deps.spawnGate)
    if (!lowerReported) {
      lower.resolve({
        kind: 'physical',
        completion: physical.completion,
        exitCode: physical.exitCode,
        recover: physical.recover
      })
    }
    physical.observeExit()
    opts.onPhysicalOwner?.(physical.completion, physical.exitCode)
    onPublished(opts.sessionId, physical.exitCode() === null)
  } catch (error) {
    if (!lowerReported) {
      lower.resolve({ kind: 'unknown' })
    }
    throw error
  }

  const staging: { current?: StartupCommandStaging } = {}
  // Reconcile fallback-shell capability or its first command could remain queued until timeout.
  const shellReadySupported =
    (opts.shellReadySupported ?? false) &&
    (subprocess.shellPath === undefined || shellPathSupportsPtyStartupBarrier(subprocess.shellPath))
  const session = new Session({
    sessionId: opts.sessionId,
    cols: size.cols,
    rows: size.rows,
    terminalHandle: opts.env?.ORCA_TERMINAL_HANDLE,
    launchAgent: opts.launchAgent,
    subprocess,
    ownerBackend: resolvePtyOwnerBackend({
      platform: process.platform,
      shellPath: subprocess.shellPath,
      wslDistro
    }),
    shellReadySupported,
    scrollback: resolveDaemonSessionScrollbackRows(),
    historySeedChunks: opts.historySeedChunks,
    ...(opts.startupIngress ? { startupIngress: opts.startupIngress } : {}),
    wslDistro,
    onExit: createSessionExitHandler(
      deps.onSessionExit,
      opts.sessionId,
      opts.agentSessionGeneration,
      staging,
      deps.spawnGate
    ),
    ...(deps.reportReadinessEvent ? { reportReadinessEvent: deps.reportReadinessEvent } : {}),
    ...(opts.shellReadyTimeoutMs !== undefined
      ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
      : {})
  })
  physical.useRecovery(recoverUnpublishedTerminalSession(session))
  opts.onPhysicalOwner?.(session.physicalCompletion, terminalSessionExitCode(session))
  recordSessionSpawnPaneKey(session, opts.env?.ORCA_PANE_KEY)

  try {
    trackSessionInput(session, subprocess, deps.reportReadinessEvent)
  } catch (error) {
    void session.physicalCompletion.then(session.dispose.bind(session))
    throw error
  }

  if (opts.isCanceled?.()) {
    // Retain cleanup ownership if the native child refuses to exit.
    deps.sessions.set(opts.sessionId, session)
    // Retain the live-cap charge until physical exit.
    onPublished(opts.sessionId, session.isAlive)
    await session.forceKillAndWaitForExit().catch(() => {})
    if (!session.isAlive && deps.sessions.get(opts.sessionId) === session) {
      session.dispose()
      deps.sessions.delete(opts.sessionId)
      deps.onDeadSessionRemoved(opts.sessionId)
      deps.spawnGate?.onSessionExit(opts.sessionId)
    }
    throw new TerminalAttachCanceledError(opts.sessionId)
  }

  deps.sessions.set(opts.sessionId, session)
  deps.onSessionCreated(opts.sessionId, opts.agentSessionGeneration, session.isAlive)
  onPublished(opts.sessionId, session.isAlive)
  const token = session.attachClient(opts.streamClient)
  attachSessionInputViewer(session, opts.streamClient)

  const startupCommandWritten =
    Boolean(opts.command) && !subprocess.startupCommandDeliveredInShellArgs
  // Distinguish absent from undelivered commands; log only length because command text may contain credentials.
  try {
    deps.reportReadinessEvent?.('startup-command-delivery', {
      sessionId: opts.sessionId,
      written: startupCommandWritten,
      hasCommand: Boolean(opts.command),
      commandLength: opts.command?.length ?? 0,
      viaShellArgs: subprocess.startupCommandDeliveredInShellArgs === true,
      queuedByShellReadyBarrier: shellReadySupported
    })
  } catch {
    // Diagnostics must never turn a live PTY into a failed create.
  }
  if (startupCommandWritten && opts.command) {
    staging.current = stageStartupCommand({
      command: opts.command,
      shellPath: subprocess.shellPath,
      orcaBuiltLine: opts.launchAgent !== undefined
    })
    const notice = startupStagingFailureNotice(staging.current)
    if (notice) {
      session.startupIngress.accept(notice)
      try {
        deps.reportReadinessEvent?.('startup-command-stage-failed', {
          sessionId: opts.sessionId,
          reason: staging.current.failure
        })
      } catch {
        // Diagnostics must never turn a live PTY into a failed create.
      }
    }
    // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
    session.writeStartupCommand(
      buildStartupCommandSubmission(staging.current.command, {
        bracketedPasteSafe: shellReadySupported
      })
    )
  }

  return {
    isNew: true,
    snapshot: null,
    pid: subprocess.pid,
    shellState: session.shellState,
    incarnationId: session.incarnationId,
    ...getDaemonSessionResultMetadata(session),
    ...(isSessionInputClosed(session) ? { inputClosed: true as const } : {}),
    ...(cwdReadableByDaemon !== null ? { cwdReadableByDaemon } : {}),
    attachToken: token
  }
}
