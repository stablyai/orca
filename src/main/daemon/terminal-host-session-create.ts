import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import {
  discardStagedStartupCommand,
  stageStartupCommand,
  startupStagingFailureNotice,
  type StartupCommandStaging
} from '../../shared/startup-command-staging'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'
import { enumerateDirectoryOnce } from './directory-enumeration-probe'
import { normalizePtySize } from './daemon-pty-size'
import { Session } from './session'
import { shellPathSupportsPtyStartupBarrier } from './shell-ready'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalSpawnGate } from './terminal-spawn-gate'
import type { LegacyRestoreDetails } from './legacy-restore-records'
import { resolveDaemonSessionScrollbackRows } from './daemon-session-scrollback-window'
import { TerminalAttachCanceledError } from './daemon-errors'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'
import { sharedPromiseSettlementWaiters } from '../../shared/promise-settlement-waiters'
import { SessionNotFoundError } from './types'
import { resolveWslSessionContext } from './wsl-session-context'
import { recordSessionSpawnPaneKey } from './terminal-host-session-listing'
import {
  attachSessionInputViewer,
  isSessionInputClosed,
  trackSessionInput
} from './session-input-path'

type TerminalHostSessionCreateDependencies = {
  sessions: Map<string, Session>
  /** Re-checks the host's shutdown fence and this request's cancellation after any await. */
  assertCreateAllowed: () => void
  sessionTeardown: TerminalSessionTeardown
  killedTombstones: TerminalHostTombstones
  spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  spawnGate: TerminalSpawnGate | undefined
  onDeadSessionRemoved: (sessionId: string) => void
  onSessionCreated: (sessionId: string, generation: string | undefined, isAlive: boolean) => void
  onSessionExit: (sessionId: string, generation: string | undefined) => void
  reportReadinessEvent?: (event: string, details: Record<string, unknown>) => void
}

export async function createOrAttachTerminalSession(
  opts: InternalCreateOrAttachOptions,
  deps: TerminalHostSessionCreateDependencies
): Promise<CreateOrAttachResult> {
  opts.onSessionResolved?.(opts.sessionId)
  let existing = deps.sessions.get(opts.sessionId)

  // Finish descendant capture before attaching to or replacing a session owned by teardown.
  if (deps.sessionTeardown.get(opts.sessionId) || existing?.isTerminating) {
    if (opts.attachOnly) {
      throw new SessionNotFoundError(opts.sessionId)
    }
    // Respawn on the same stable ID must wait for teardown to release its previous owner.
    await waitForTerminalAttachOperation(
      deps.sessionTeardown.settle(opts.sessionId),
      opts.cancelSignal,
      opts.sessionId
    )
    deps.assertCreateAllowed()
    existing = deps.sessions.get(opts.sessionId)
    // A live terminating owner still reserves the ID, including if teardown began again while waiting.
    if (existing?.isAlive && existing.isTerminating) {
      throw new SessionNotFoundError(opts.sessionId)
    }
  }

  // Attach synchronously: in-flight recovery resets arrive after the snapshot in stream order.
  // Checkpoint readers that require settled ownership use getSettledSnapshot.
  if (existing && existing.isAlive && !existing.isTerminating) {
    const snapshot = existing.getSnapshot()
    existing.detachAllClients()
    const token = existing.attachClient(opts.streamClient)
    attachSessionInputViewer(existing, opts.streamClient)
    return {
      isNew: false,
      snapshot,
      pid: existing.pid,
      shellState: existing.shellState,
      incarnationId: existing.incarnationId,
      ...getDaemonSessionResultMetadata(existing),
      ...(isSessionInputClosed(existing) ? { inputClosed: true as const } : {}),
      attachToken: token
    }
  }

  if (existing?.isAlive && existing.isTerminating) {
    // Wait for physical exit to avoid hiding two live generations behind one public ID.
    throw new Error(`Session "${opts.sessionId}" is terminating`)
  }
  if (opts.attachOnly) {
    // An adopted claim cannot authorize spawning an unclaimed shell after an exit race.
    throw new SessionNotFoundError(opts.sessionId)
  }

  if (existing) {
    existing.dispose()
    deps.sessions.delete(opts.sessionId)
    deps.onDeadSessionRemoved(opts.sessionId)
  }

  deps.killedTombstones.clearForCreate(opts.sessionId)
  const size = normalizePtySize(opts.cols, opts.rows)
  const wslDistro = resolveWslSessionContext(opts)?.distro
  const sessionId = opts.sessionId
  let lease = deps.spawnGate?.admit(
    {
      clientId: opts.spawnAdmission?.clientId ?? 'in-process',
      declaredIntent: opts.spawnAdmission?.declaredIntent ?? null,
      hasAgentSessionClaim: opts.agentSessionEnsure !== undefined,
      hasHistorySeed: (opts.historySeedChunks?.length ?? 0) > 0,
      deadlineAt: opts.spawnAdmission?.deadlineAt ?? Number.POSITIVE_INFINITY
    },
    opts.cancelSignal
      ? { signal: opts.cancelSignal, error: () => new TerminalAttachCanceledError(sessionId) }
      : undefined,
    describeAgentRestore(opts)
  )
  const paced = lease instanceof Promise
  if (lease instanceof Promise) {
    lease = await lease
  }
  try {
    if (paced) {
      // Pacing can outlast shutdown or cancellation; recheck before spawning.
      deps.assertCreateAllowed()
    }
    return await spawnAndPublishSession(opts, deps, { size, wslDistro }, (publishedId, isAlive) =>
      lease?.commit(publishedId, isAlive)
    )
  } finally {
    lease?.abandon()
  }
}

async function spawnAndPublishSession(
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
  const subprocess = await deps.spawnSubprocess({
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
    ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {})
  })

  let staging: StartupCommandStaging | undefined
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
      () => discardStagedStartupCommand(staging),
      deps.spawnGate
    ),
    ...(deps.reportReadinessEvent ? { reportReadinessEvent: deps.reportReadinessEvent } : {}),
    ...(opts.shellReadyTimeoutMs !== undefined
      ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
      : {})
  })
  recordSessionSpawnPaneKey(session, opts.env?.ORCA_PANE_KEY)

  trackSessionInput(session, subprocess, deps.reportReadinessEvent)

  if (opts.isCanceled?.()) {
    // Retain cleanup ownership if the native child refuses to exit.
    deps.sessions.set(opts.sessionId, session)
    // Retain the live-cap charge until physical exit.
    onPublished(opts.sessionId, session.isAlive)
    await session.forceKillAndDisposeSubprocess()
    if (deps.sessions.get(opts.sessionId) === session) {
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
    staging = stageStartupCommand({
      command: opts.command,
      shellPath: subprocess.shellPath,
      orcaBuiltLine: opts.launchAgent !== undefined
    })
    const notice = startupStagingFailureNotice(staging)
    if (notice) {
      session.startupIngress.accept(notice)
      try {
        deps.reportReadinessEvent?.('startup-command-stage-failed', {
          sessionId: opts.sessionId,
          reason: staging.failure
        })
      } catch {
        // Diagnostics must never turn a live PTY into a failed create.
      }
    }
    // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
    session.writeStartupCommand(
      buildStartupCommandSubmission(staging.command, {
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

function createSessionExitHandler(
  onSessionExit: TerminalHostSessionCreateDependencies['onSessionExit'],
  sessionId: string,
  generation: string | undefined,
  discardStagedCommand: () => void,
  spawnGate: TerminalSpawnGate | undefined
): () => void {
  return () => {
    discardStagedCommand()
    spawnGate?.onSessionExit(sessionId)
    onSessionExit(sessionId, generation)
  }
}

/** Describe restore identity without including environment values that may contain credentials. */
function describeAgentRestore(
  opts: InternalCreateOrAttachOptions
): LegacyRestoreDetails | undefined {
  if (!opts.command || (!opts.launchAgent && !opts.agentSessionEnsure)) {
    return undefined
  }
  return {
    sessionId: opts.sessionId,
    agent: opts.launchAgent ?? opts.agentSessionEnsure?.claim.agent ?? null,
    cwd: opts.cwd ?? null,
    worktreeId: opts.agentSessionEnsure?.surface.worktreeId ?? null,
    command: opts.command,
    identityDigest: opts.agentSessionEnsure?.claim.identityDigest ?? null
  }
}

// TCC may reject directory enumeration despite successful access(); only explicit permission denial counts.
async function isCwdReadableByThisProcess(
  cwd: string,
  opts: Pick<InternalCreateOrAttachOptions, 'sessionId' | 'cancelSignal'>
): Promise<boolean | null> {
  const outcome = await sharedPromiseSettlementWaiters(enumerateDirectoryOnce(cwd))
    .wait({
      timeoutMs: 1_000,
      signal: opts.cancelSignal,
      createAbortError: () => new TerminalAttachCanceledError(opts.sessionId)
    })
    .catch((error: unknown) => {
      if (error instanceof TerminalAttachCanceledError) {
        throw error
      }
      return null
    })
  return outcome === null ? null : outcome !== 'denied'
}
