import { accessSync, constants as fsConstants } from 'node:fs'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'
import { normalizePtySize } from './daemon-pty-size'
import { Session } from './session'
import { shellPathSupportsPtyStartupBarrier } from './shell-ready'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import { resolveDaemonSessionScrollbackRows } from './daemon-session-scrollback-window'
import { TerminalAttachCanceledError } from './daemon-errors'
import { rejectOnAbort } from './terminal-attach-cancellation'
import { SessionNotFoundError } from './types'
import { resolveWslSessionContext } from './wsl-session-context'

type TerminalHostSessionCreateDependencies = {
  sessions: Map<string, Session>
  /** Re-checks the host's shutdown fence and this request's cancellation after any await. */
  assertCreateAllowed: () => void
  sessionTeardown: TerminalSessionTeardown
  killedTombstones: TerminalHostTombstones
  spawnSubprocess: TerminalHostOptions['spawnSubprocess']
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

  // Why: descendant capture must finish before attach or recreation, or the
  // caller could receive a doomed session while teardown owns its process.
  if (deps.sessionTeardown.get(opts.sessionId) || existing?.isTerminating) {
    // An attach must not adopt a doomed session; its caller retires the pane and respawns.
    if (opts.attachOnly) {
      throw new SessionNotFoundError(opts.sessionId)
    }
    // A create can wait teardown out instead, and must: a pane respawning onto its own stable id
    // reaches this a beat after the attach that retired it, and refusing surfaced the raw
    // SessionNotFoundError to the user. Windows makes it the common case, where the plain-shell
    // sweep holds the claim across an OS identity probe and taskkill (#18046).
    await Promise.race([
      deps.sessionTeardown.settle(opts.sessionId),
      rejectOnAbort(opts.cancelSignal, opts.sessionId)
    ])
    deps.assertCreateAllowed()
    existing = deps.sessions.get(opts.sessionId)
    // Unkillable child, or a fresh teardown claimed it while we waited: still nobody's to recreate.
    if (existing?.isAlive && existing.isTerminating) {
      throw new SessionNotFoundError(opts.sessionId)
    }
  }

  // Why no ownership settle here: attach is synchronous by contract. A viewer
  // connecting inside an in-flight recovery proof (~100ms) gets the pre-reset
  // snapshot and the injected reset arrives in-order over its stream — a
  // self-healing first frame. Waiting instead created a race window (cancel,
  // exit, kill during the await) that produced repeated regressions. Checkpoint
  // readers that need a settled owner use getSettledSnapshot.
  if (existing && existing.isAlive && !existing.isTerminating) {
    const snapshot = existing.getSnapshot()
    existing.detachAllClients()
    const token = existing.attachClient(opts.streamClient)
    return {
      isNew: false,
      snapshot,
      pid: existing.pid,
      shellState: existing.shellState,
      incarnationId: existing.incarnationId,
      ...getDaemonSessionResultMetadata(existing),
      attachToken: token
    }
  }

  if (existing?.isAlive && existing.isTerminating) {
    // Why: replacing a SIGKILLed-but-unreaped child could hide two live
    // generations behind the same public session id.
    throw new Error(`Session "${opts.sessionId}" is terminating`)
  }
  if (opts.attachOnly) {
    // Why: an adopted claim proves only one owner generation; it must never
    // turn an exit race into permission to spawn an unclaimed shell.
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
  return await spawnAndPublishSession(opts, deps, { size, wslDistro })
}

async function spawnAndPublishSession(
  opts: InternalCreateOrAttachOptions,
  deps: TerminalHostSessionCreateDependencies,
  ctx: { size: { cols: number; rows: number }; wslDistro: string | undefined }
): Promise<CreateOrAttachResult> {
  const { size, wslDistro } = ctx
  // Why before the fork: the shell's own cwd may already have fallen back, so probe the requested path.
  const cwdReadableByDaemon = opts.cwd && !wslDistro ? isCwdReadableByThisProcess(opts.cwd) : null
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
    terminalWindowsWslDistro: opts.terminalWindowsWslDistro,
    terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation,
    isCanceled: opts.isCanceled,
    ...(opts.cancelSignal ? { cancelSignal: opts.cancelSignal } : {})
  })

  // Why: a fallback shell does not emit the preferred shell's ready marker;
  // retaining the stale capability would indefinitely queue its first command.
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
    onExit: () => deps.onSessionExit(opts.sessionId, opts.agentSessionGeneration),
    ...(deps.reportReadinessEvent ? { reportReadinessEvent: deps.reportReadinessEvent } : {}),
    ...(opts.shellReadyTimeoutMs !== undefined
      ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
      : {})
  })

  if (opts.isCanceled?.()) {
    // Retain cleanup ownership if the native child refuses to exit.
    deps.sessions.set(opts.sessionId, session)
    await session.forceKillAndDisposeSubprocess()
    if (deps.sessions.get(opts.sessionId) === session) {
      session.dispose()
      deps.sessions.delete(opts.sessionId)
      deps.onDeadSessionRemoved(opts.sessionId)
    }
    throw new TerminalAttachCanceledError(opts.sessionId)
  }

  deps.sessions.set(opts.sessionId, session)
  deps.onSessionCreated(opts.sessionId, opts.agentSessionGeneration, session.isAlive)
  const token = session.attachClient(opts.streamClient)

  const startupCommandWritten =
    Boolean(opts.command) && !subprocess.startupCommandDeliveredInShellArgs
  // Why: without this, a missing command and a lost one log identically.
  // Length, never the text -- launches can carry credentials.
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
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: only Orca-wrapped shells advertise the paste-safe startup barrier.
    session.write(
      buildStartupCommandSubmission(opts.command, {
        submit,
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
    ...(cwdReadableByDaemon !== null ? { cwdReadableByDaemon } : {}),
    attachToken: token
  }
}

// Why R_OK|X_OK: listing a directory needs read, and entering it needs search — both are what
// TCC withholds. A non-permission failure (ENOENT, ENOTDIR) reads as readable so it can never
// masquerade as a permission denial.
function isCwdReadableByThisProcess(cwd: string): boolean {
  try {
    accessSync(cwd, fsConstants.R_OK | fsConstants.X_OK)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code !== 'EACCES' && code !== 'EPERM'
  }
}
