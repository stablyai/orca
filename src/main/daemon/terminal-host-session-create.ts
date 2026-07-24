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
import { SessionNotFoundError } from './types'
import { resolveWslSessionContext } from './wsl-session-context'

type TerminalHostSessionCreateDependencies = {
  sessions: Map<string, Session>
  sessionTeardown: TerminalSessionTeardown
  killedTombstones: TerminalHostTombstones
  spawnSubprocess: TerminalHostOptions['spawnSubprocess']
  creationFenced: boolean
  onDeadSessionRemoved: (sessionId: string) => void
  onSessionCreated: (sessionId: string, generation: string | undefined, isAlive: boolean) => void
  onSessionExit: (sessionId: string, generation: string | undefined) => void
}

export async function createOrAttachTerminalSession(
  opts: InternalCreateOrAttachOptions,
  deps: TerminalHostSessionCreateDependencies
): Promise<CreateOrAttachResult> {
  if (deps.creationFenced) {
    throw new Error('Terminal host is shutting down')
  }
  opts.onSessionResolved?.(opts.sessionId)
  const existing = deps.sessions.get(opts.sessionId)

  // Why: descendant capture must finish before attach or recreation, or the
  // caller could receive a doomed session while teardown owns its process.
  if (deps.sessionTeardown.get(opts.sessionId) || existing?.isTerminating) {
    throw new SessionNotFoundError(opts.sessionId)
  }

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
  const subprocess = deps.spawnSubprocess({
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
    terminalWindowsPowerShellImplementation: opts.terminalWindowsPowerShellImplementation
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
    historySeed: opts.historySeed,
    ...(opts.startupIngress ? { startupIngress: opts.startupIngress } : {}),
    wslDistro,
    onExit: () => deps.onSessionExit(opts.sessionId, opts.agentSessionGeneration),
    ...(opts.shellReadyTimeoutMs !== undefined
      ? { shellReadyTimeoutMs: opts.shellReadyTimeoutMs }
      : {})
  })

  deps.sessions.set(opts.sessionId, session)
  deps.onSessionCreated(opts.sessionId, opts.agentSessionGeneration, session.isAlive)
  const token = session.attachClient(opts.streamClient)

  if (opts.command && !subprocess.startupCommandDeliveredInShellArgs) {
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
    attachToken: token
  }
}
