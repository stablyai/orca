import { terminalSessionExitCode } from './terminal-host-returned-process'
import { settleUnpublishedTerminalSpawnLease } from './terminal-creation-work'
import { spawnAndPublishSession } from './terminal-host-session-publish'
import { getDaemonSessionResultMetadata } from './daemon-create-or-attach-result'
import { normalizePtySize } from './daemon-pty-size'
import type { Session } from './session'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type { TerminalHostOptions } from './terminal-host-options'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalSpawnGate } from './terminal-spawn-gate'
import { TerminalAttachCanceledError } from './daemon-errors'
import { waitForTerminalAttachOperation } from './terminal-attach-cancellation'
import { SessionNotFoundError } from './types'
import { resolveWslSessionContext } from './wsl-session-context'
import { attachSessionInputViewer, isSessionInputClosed } from './session-input-path'
import { describeAgentRestore } from './terminal-host-session-process'
export type TerminalHostSessionCreateDependencies = {
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
    deps.assertCreateAllowed()
    const attachedSession = existing
    opts.onPhysicalOwner?.(
      attachedSession.physicalCompletion,
      terminalSessionExitCode(attachedSession)
    )
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
  const spawnGate = deps.spawnGate
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
  let published = false
  try {
    if (paced) {
      // Pacing can outlast shutdown or cancellation; recheck before spawning.
      deps.assertCreateAllowed()
    }
    const result = await spawnAndPublishSession(
      opts,
      deps,
      { size, wslDistro },
      (publishedId, isAlive) => lease?.commit(publishedId, isAlive)
    )
    published = true
    return result
  } finally {
    const admitted = lease
    if (published || !opts.creationWork) {
      admitted?.abandon()
    } else {
      settleUnpublishedTerminalSpawnLease(
        opts.creationWork.completion,
        admitted,
        sessionId,
        spawnGate
      )
    }
  }
}
