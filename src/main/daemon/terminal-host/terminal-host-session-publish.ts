import { terminalStartError } from '../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type { PtyCreationDisposition } from '../../../shared/terminal/pty/lifecycle/pty-creation-disposition'
import type { SubprocessHandle } from '../sessions/session-subprocess-handle'
import type { WslGuestRoot } from '../../../shared/shell/wsl/wsl-guest-root-marker'
import {
  discardStagedStartupCommandAsync,
  stageStartupCommand,
  type StartupCommandStaging
} from '../../../shared/shell/launch/startup-command-staging'
import { resolvePtyOwnerBackend } from '../../../shared/terminal/pty/lifecycle/pty-owner-backend'
import { getDaemonSessionResultMetadata } from '../protocol/daemon-create-or-attach-result'
import { Session } from '../sessions/session'
import {
  observeReturnedTerminalProcess,
  recoverUnpublishedTerminalSession,
  terminalSessionExitCode
} from './terminal-host-returned-process'
import { shellPathSupportsPtyStartupBarrier } from '../shell-readiness/shell-ready'
import { createStartupCommandFallback } from '../pty-subprocess/shell-wrapper-startup-claim'
import {
  buildStartupSubmission,
  submitStagedStartupCommand,
  type StartupSubmissionInputs
} from './terminal-host-startup-submission'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import { resolveDaemonSessionScrollbackRows } from '../sessions/daemon-session-scrollback-window'
import { TerminalAttachCanceledError } from '../protocol/daemon-errors'
import {
  recordSessionSpawnPaneKey,
  recordSessionWslGuestRoot
} from './terminal-host-session-listing'
import {
  attachSessionInputViewer,
  isSessionInputClosed,
  trackSessionInput
} from '../sessions/session-input-path'
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
  const staging: { current?: StartupCommandStaging } = {}
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
      ...(opts.shellReadySupported ? { shellReadySupported: true } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      shellOverride: opts.shellOverride,
      terminalShellArgs: opts.terminalShellArgs,
      terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
      terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
      isCanceled: opts.isCanceled,
      assertCreateAllowed: deps.assertCreateAllowed,
      ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {})
    })
    // Claim the wrapper's staged script now so every later failure path still unlinks it.
    staging.current = subprocess.shellWrapperStartup?.staging
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

  // Reconcile fallback-shell capability or its first command could remain queued until timeout.
  const shellReadySupported =
    (opts.shellReadySupported ?? false) &&
    (subprocess.shellPath === undefined || shellPathSupportsPtyStartupBarrier(subprocess.shellPath))
  // Why: output buffered before the session subscribes replays while it is constructed, so a root
  // found then is held and recorded once the session exists.
  let heldRoot: WslGuestRoot | undefined
  let recordRoot = (root: WslGuestRoot): void => {
    heldRoot = root
  }
  const wrapperStartup = opts.command ? subprocess.shellWrapperStartup : undefined
  const wrapperCommand = opts.command
  // A profile that execs another shell never reaches the wrapper; type the line only if the wrapper never claimed it.
  const startupCommandFallback =
    wrapperStartup && wrapperCommand
      ? createStartupCommandFallback(wrapperStartup.claimPath, () => {
          void discardStagedStartupCommandAsync(wrapperStartup.staging)
          return buildSubmission(wrapperCommand)
        })
      : undefined
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
    ...(startupCommandFallback ? { startupCommandFallback } : {}),
    scrollback: resolveDaemonSessionScrollbackRows(),
    historySeedChunks: opts.historySeedChunks,
    ...(opts.startupIngress ? { startupIngress: opts.startupIngress } : {}),
    wslDistro,
    // A WSL guest root rides only this live session's inventory row; it dies with the session.
    ...(wslDistro ? { onWslGuestRoot: (root) => recordRoot(root) } : {}),
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
  recordRoot = (root) => recordSessionWslGuestRoot(session, root)
  if (heldRoot) {
    recordRoot(heldRoot)
  }
  physical.useRecovery(recoverUnpublishedTerminalSession(session))
  opts.onPhysicalOwner?.(session.physicalCompletion, terminalSessionExitCode(session))
  if (!session.isAlive) {
    const error = terminalStartError(
      'agent_session_exited_during_start',
      session.exitCause,
      session.incarnationId
    )
    session.dispose()
    throw error
  }
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

  // The wrapper runs the command at its first prompt (or first precmd without zle), so nothing is typed
  // ahead of the user and early keystrokes queue for the agent.
  const startupCommandByWrapper = wrapperStartup !== undefined
  const startupCommandWritten =
    Boolean(opts.command) &&
    !subprocess.startupCommandDeliveredInShellArgs &&
    !startupCommandByWrapper
  // Distinguish absent from undelivered commands; log only length because command text may contain credentials.
  try {
    deps.reportReadinessEvent?.('startup-command-delivery', {
      sessionId: opts.sessionId,
      written: startupCommandWritten,
      hasCommand: Boolean(opts.command),
      commandLength: opts.command?.length ?? 0,
      viaShellArgs: subprocess.startupCommandDeliveredInShellArgs === true,
      viaShellWrapper: startupCommandByWrapper,
      queuedByShellReadyBarrier: shellReadySupported
    })
  } catch {
    // Diagnostics must never turn a live PTY into a failed create.
  }
  // Module-level builder with explicit inputs: closures here share this scope with session-lifetime callbacks.
  const submission: StartupSubmissionInputs = {
    staging,
    session,
    shellPath: subprocess.shellPath,
    orcaBuiltLine: opts.launchAgent !== undefined,
    shellReadySupported,
    sessionId: opts.sessionId,
    reportReadinessEvent: deps.reportReadinessEvent
  }
  const buildSubmission = (command: string): Promise<string> =>
    buildStartupSubmission(command, submission)
  if (startupCommandWritten && opts.command) {
    // Staged synchronously so the command reserves its barrier slot before any ready marker is read.
    const staged = stageStartupCommand({
      command: opts.command,
      shellPath: subprocess.shellPath,
      orcaBuiltLine: opts.launchAgent !== undefined
    })
    session.writeStartupCommand(submitStagedStartupCommand(staged, submission))
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
