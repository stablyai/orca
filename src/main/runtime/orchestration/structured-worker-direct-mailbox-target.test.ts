import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { OrcaRuntimeWithGetPtyRecordForPaneKey } =
  await import('../orca-runtime-get-pty-record-for-pane-key')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('../structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

/** The real method through the real prototype chain; a re-declared copy would pin nothing. */
class MailboxTargetProbe extends OrcaRuntimeWithGetPtyRecordForPaneKey {
  probeResolveTarget(mailboxHandle: string): unknown {
    return this.resolveStructuredMailboxTarget(mailboxHandle)
  }
}

function installRecord(lease: { runtimeKind: string; claimStatus: string }): void {
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          ({
            sessionId,
            location: { executionHostId: 'local', wslDistro: null },
            lease: { ...lease, runtimeFence: 1, deathEvidence: null }
          }) as unknown as AgentSessionRecord
      }
    },
    hasSession: () => true
  }
}

function registerWorker(): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt_1',
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

function probe(activeDispatch: { id: string } | undefined, run?: { coordinator_handle: string }) {
  const findActiveDispatchForAssignee = vi.fn(() => activeDispatch)
  const getRun = vi.fn(() => run)
  const instance = Object.assign(Object.create(MailboxTargetProbe.prototype), {
    _orchestrationDb: { findActiveDispatchForAssignee, getRun },
    getLiveLeafForHandle: () => {
      throw new Error('no leaf backs a native-born structured worker')
    }
  }) as MailboxTargetProbe
  return { instance, findActiveDispatchForAssignee, getRun }
}

describe('the mailbox target for direct peer mail to a structured worker', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('routes a bare worker handle through the active dispatch that worker holds', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    const { instance, findActiveDispatchForAssignee } = probe({ id: 'd1' })
    expect(instance.probeResolveTarget(handle)).toEqual({
      sessionId: SESSION_ID,
      dispatchId: 'd1'
    })
    // The pane key is the remint-stable half of the lookup, exactly as the PTY path uses it.
    expect(findActiveDispatchForAssignee).toHaveBeenCalledWith(
      handle,
      structuredWorkerIdentities.get(handle)!.paneKey
    )
  })

  it('still delivers to a worker that has no active dispatch', () => {
    // The defect this pins: the send stored durably and reported success, and then NEITHER lane
    // claimed the mailbox — the PTY lane refuses a structured handle outright and this resolver
    // answered only `dispatch:` addresses. The worker never reacted and the peer waiting on a
    // reply hung, with nothing logged. A dispatch says nothing about whether delivery is safe;
    // the idle gate and the lease fence do, and both still run downstream.
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(probe(undefined).instance.probeResolveTarget(handle)).toEqual({
      sessionId: SESSION_ID,
      dispatchId: null
    })
  })

  it('leaves a handle whose session this runtime no longer owns to the PTY lane', () => {
    const handle = registerWorker()
    installRecord({ runtimeKind: 'tui', claimStatus: 'live' })
    expect(probe({ id: 'd1' }).instance.probeResolveTarget(handle)).toBeNull()
    installRecord({ runtimeKind: 'native', claimStatus: 'released' })
    expect(probe({ id: 'd1' }).instance.probeResolveTarget(handle)).toBeNull()
  })

  it('claims a PTY handle for neither lane', () => {
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    const { instance, findActiveDispatchForAssignee } = probe({ id: 'd1' })
    expect(instance.probeResolveTarget('term_abc')).toBeNull()
    expect(findActiveDispatchForAssignee).not.toHaveBeenCalled()
  })
})

describe('the mailbox target for a Run whose coordinator is structured', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('owns the run mailbox, which neither lane used to claim', () => {
    // The defect this pins: the PTY lane declines because the owner is structured, and this lane
    // used to decline anything that was not `dispatch:`. Each half believed the other owned it, so
    // a structured coordinator was never nudged for its own Run mail and nothing logged. A PTY
    // coordinator is covered by blocking in `check --wait`; a chat session's turn just ends.
    const handle = registerWorker()
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(
      probe(undefined, { coordinator_handle: handle }).instance.probeResolveTarget('run:run_1')
    ).toEqual({ sessionId: SESSION_ID, dispatchId: null })
  })

  it('leaves the run mailbox of a PTY coordinator to the PTY lane', () => {
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(
      probe(undefined, { coordinator_handle: 'term_coord' }).instance.probeResolveTarget(
        'run:run_1'
      )
    ).toBeNull()
  })

  it('claims nothing for a run that does not resolve', () => {
    installRecord({ runtimeKind: 'native', claimStatus: 'live' })
    expect(probe(undefined).instance.probeResolveTarget('run:run_1')).toBeNull()
  })
})
