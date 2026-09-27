// A startup reconcile that fails leaves a crashed chat's turn unsettled: only reconcile can say its
// agent is gone. The first clean reconcile after it, from a bounded retry or from anyone, must
// settle every listed chat that owes it, not only the ones some reader happened to open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  createStartupRig,
  isOpen,
  latestStatus,
  type StartupRig
} from './structured-agent-session-startup-pass-test-rig'

let rig: StartupRig

beforeEach(async () => {
  rig = await createStartupRig()
})

afterEach(async () => {
  await rig.dispose()
})

const owesSettlement = (sessionId: string) =>
  rig.store.getRecord(sessionId)?.lease.settlementRetryRequired === true

/** A second run's send, then a crash with the provider's turn still running. */
async function crashMidTurn(sessionId: string): Promise<void> {
  await rig.chat(sessionId, { message: 'first' })
  await rig.quit()
  const host = await rig.boot()
  await host.restoreStartupSessions()
  await rig.chat(sessionId, { message: 'second' })
  const { journal } = rig.host.collaboratorsForTests().sessions.get(sessionId)!
  // The provider's turn is still running when the app dies.
  await journal.appendItem(
    { provider: 'codex', threadId: `thread-${sessionId}`, turnId: 'turn-running', ordinal: 99 },
    { kind: 'turn', turnId: 'turn-running', state: 'running', startedAt: 1 },
    { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence }
  )
  await rig.crash()
}

/** Settled as `unverifiable`, so no verdict; the dead-generation crash verdict is a follow-up. */
function expectSettledUnverifiable(snapshot: { items: readonly AgentJournalRenderItem[] }): void {
  expect(latestStatus(rig, 'session-a')?.turnOutcome).toBeUndefined()
  expect(
    snapshot.items.flatMap((item) => (item.body.kind === 'turn' ? [item.body.state] : []))
  ).toEqual(['unverifiable'])
}

/** Boots with every owner probe failing until `probe.fail` is cleared. */
async function bootWithFailingReconcile(deps: Partial<StructuredAgentSessionHostDeps> = {}) {
  const probe = { fail: true }
  rig.probeOwner.mockImplementation(async () => {
    if (probe.fail) {
      throw new Error('probe unavailable')
    }
    return { outcome: 'pid-absent' }
  })
  const host = await rig.boot({ savedStatus: undefined, ...deps })
  return { host, probe }
}

describe('a startup reconcile that failed', () => {
  it('settles a crashed chat nobody opened once a later reconcile succeeds', async () => {
    await crashMidTurn('session-a')
    const { host, probe } = await bootWithFailingReconcile({
      startupReconcileRetryDelaysMs: [60_000]
    })
    await host.restoreStartupSessions()
    // The pass opened it for status and closed it again; its turn is still read as running.
    expect(isOpen(rig, 'session-a')).toBe(false)
    expect(latestStatus(rig, 'session-a')?.status).toBe('working')

    probe.fail = false
    await host.reconcileRestartLeases()

    // The settled row lands before the settlement's record write clears the flag.
    await vi.waitFor(() => {
      expect(latestStatus(rig, 'session-a')?.status).toBe('idle')
      expect(owesSettlement('session-a')).toBe(false)
    })
    expectSettledUnverifiable(await rig.host.journalSnapshot('session-a'))
  })

  it('retries the reconcile itself, so no attach is needed', async () => {
    await crashMidTurn('session-a')
    const { host, probe } = await bootWithFailingReconcile({
      startupReconcileRetryDelaysMs: [50, 50, 50]
    })
    await host.restoreStartupSessions()
    expect(latestStatus(rig, 'session-a')?.status).toBe('working')
    const acquired = rig.acquire.mock.calls.length

    probe.fail = false

    // The settled row lands before the settlement's record write clears the flag.
    await vi.waitFor(() => {
      expect(latestStatus(rig, 'session-a')?.status).toBe('idle')
      expect(owesSettlement('session-a')).toBe(false)
    })
    expectSettledUnverifiable(await rig.host.journalSnapshot('session-a'))
    expect(rig.acquire.mock.calls.length).toBe(acquired)
  })

  it('gives up after its retries, leaving the chat to its own attach', async () => {
    await crashMidTurn('session-a')
    const onEventSinkError = vi.fn()
    const { host } = await bootWithFailingReconcile({
      startupReconcileRetryDelaysMs: [20, 20, 20],
      onEventSinkError
    })
    await host.restoreStartupSessions()
    await vi.waitFor(() =>
      expect(onEventSinkError).toHaveBeenCalledWith({
        sessionId: 'startup-pass',
        error: expect.objectContaining({ message: expect.stringContaining('after its retries') })
      })
    )
    expect(latestStatus(rig, 'session-a')?.status).toBe('working')
  })

  it('stops retrying once quit begins', async () => {
    await crashMidTurn('session-a')
    const { host } = await bootWithFailingReconcile({ startupReconcileRetryDelaysMs: [50, 50, 50] })
    await host.restoreStartupSessions()
    await rig.crash()
    const probes = rig.probeOwner.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(rig.probeOwner.mock.calls.length).toBe(probes)
  })
})
