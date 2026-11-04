import { afterEach, expect, it, vi } from 'vitest'
import { savedRosterRig, countRosterWork } from './agent-session-saved-roster.test-support'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { AgentSessionStatusEvent } from '../../shared/agent-session-wire'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

it.each([
  [10, 0],
  [100, 0],
  [10, 10],
  [10, 100]
])(
  'seeds %i canonical saved rows with %i existing rows, building only the completed roster',
  async (n, existing) => {
    const { host, server, store, ids, live } = await savedRosterRig(n)
    for (let i = 0; i < existing; i++) {
      live(`existing-${i}`)
    }
    server.builds = 0
    const work = countRosterWork(server)
    server.subscribeStatusRowMutations(work.rows)
    server.subscribeEnrichedStatus(work.enriched)
    const rosters = vi.fn()
    const providers = vi.fn()
    server.subscribeStatusChanges(rosters)
    server.subscribeProviderSessionChanges(providers)
    const events: AgentSessionStatusEvent[] = []
    host.subscribeStatus({ id: 'before-seed', emit: (event) => events.push(event) })
    const writes = vi.spyOn(store, 'transitionHandoff')
    const journals = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    await host.seedSessionTabs(ids)
    expect(journals).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(work.revision).toHaveBeenCalledTimes(n)
    expect(work.mutation).toHaveBeenCalledTimes(n)
    expect(work.listing).toHaveBeenCalledTimes(n)
    expect(work.subjects).toHaveBeenCalledTimes(n)
    expect(work.rows).toHaveBeenCalledTimes(n)
    expect(work.enriched).toHaveBeenCalledTimes(n)
    expect(work.snapshots).not.toHaveBeenCalled()
    expect(server.builds).toBe(1)
    expect(work.counts).toEqual({ enumerations: 1, parentVisits: existing + n })
    const expectedPanes = [
      ...Array.from({ length: existing }, (_, i) => `existing-${i}`),
      ...ids
    ].map((id) => structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id))
    expect(rosters).toHaveBeenCalledExactlyOnceWith(
      expectedPanes.map((paneKey, i) => ({
        paneKey,
        state: i < existing ? 'working' : 'done',
        receivedAt: expect.any(Number),
        observedInCurrentRuntime: true
      }))
    )
    expect(providers).toHaveBeenCalledExactlyOnceWith(
      expectedPanes.slice(0, existing).map((paneKey, i) => ({
        paneKey,
        sessionId: `provider-existing-${i}`,
        worktreeId: 'workspace-1'
      }))
    )
    expect(events.filter((event) => event.type === 'status')).toHaveLength(n)
    for (const id of ids) {
      expect(
        server.getStatusSnapshotForPane(
          structuredAgentSessionPaneKey(structuredAgentSessionTabId(id), id)
        )
      ).toMatchObject([
        {
          state: 'done',
          interrupted: undefined,
          mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 100 }
        }
      ])
      expect(host.readStatusSummary(id)).toMatchObject({
        sessionId: id,
        turnOutcome: 'success',
        statusStartedAt: 100
      })
    }
    const first = vi.fn()
    host.subscribeStatus({ id: 'first-client', emit: first })
    expect(first).toHaveBeenCalledWith({
      type: 'snapshot',
      sessions: ids.map((id) => host.readStatusSummary(id))
    })
    expect(server.getCanonicalStatusSnapshot().parents).toHaveLength(existing + n)
    await host.seedSessionTabs(ids)
    await host.seedSessionTabs([])
    expect(rosters).toHaveBeenCalledTimes(1)
    expect(server.builds).toBe(1)
    await store.transitionHandoff('closed-chat', (record) => ({
      ...record,
      lastTurn: { state: 'settled', outcome: 'cancellation', at: 300 }
    }))
    await host.setSessionTabVisibility('closed-chat', true)
    await host.seedSessionTabs([...ids, 'closed-chat'])
    expect(rosters).toHaveBeenCalledTimes(2)
    expect(rosters.mock.calls[1]?.[0]).toHaveLength(existing + n + 1)
    expect(host.readStatusSummary('closed-chat')).toMatchObject({
      turnOutcome: 'cancellation',
      statusStartedAt: 300
    })
  }
)

it.each(['recovery', 'capsule'] as const)(
  'leaves live roster, row and enriched delivery immediate while %s is pending',
  async (phase) => {
    const rig = await savedRosterRig(1)
    const hold = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const capsule = new AgentSessionRecoveryCapsule(rig.root)
    const probe = vi.fn(async (): Promise<AgentSessionOwnerProbe> => {
      entered.resolve()
      await hold.promise
      return { outcome: 'indeterminate', reason: 'fixture held' }
    })
    if (phase === 'recovery') {
      await rig.store.transitionHandoff(rig.ids[0]!, (record) => ({
        ...record,
        lease: { ...rig.rows[0]!.lease, unreconciled: true }
      }))
    } else {
      vi.spyOn(capsule, 'list').mockImplementation(async () => {
        entered.resolve()
        await hold.promise
        return []
      })
    }
    const host = new StructuredAgentSessionHost({
      ...rig.host.deps,
      probeOwner: probe,
      recoveryCapsule: capsule
    })
    const roster = vi.fn(),
      rows = vi.fn(),
      enriched = vi.fn()
    rig.server.subscribeStatusChanges(roster)
    rig.server.subscribeStatusRowMutations(rows)
    rig.server.subscribeEnrichedStatus(enriched)
    const pending = host.seedSessionTabs(rig.ids)
    await entered.promise
    rig.live()
    expect(roster).toHaveBeenCalledTimes(1)
    expect(rows).toHaveBeenCalledTimes(1)
    expect(enriched).toHaveBeenCalledTimes(1)
    expect(host.readStatusSummary(rig.ids[0]!)).toBeUndefined()
    hold.resolve()
    await pending
    expect(roster).toHaveBeenCalledTimes(2)
    if (phase === 'capsule') {
      vi.spyOn(capsule, 'listFailed').mockRejectedValueOnce(new Error('advisory capsule failed'))
      await host.setSessionTabVisibility('closed-chat', true)
      await host.seedSessionTabs(['closed-chat'])
      expect(host.readStatusSummary('closed-chat')).toBeDefined()
    }
  }
)

it.each(['row', 'enriched'] as const)(
  'publishes a reentrant live edge immediately from a saved %s observer then flushes later rows',
  async (observer) => {
    const { host, ids, server, live } = await savedRosterRig(2)
    const sizes: number[] = []
    server.subscribeStatusChanges((rows) => sizes.push(rows.length))
    let entered = false
    const reenter = () => {
      if (entered) {
        return
      }
      entered = true
      live()
      expect(sizes).toEqual([2])
      expect(server.getStatusSnapshot()).toHaveLength(2)
    }
    if (observer === 'row') {
      server.subscribeStatusRowMutations(reenter)
    } else {
      server.subscribeEnrichedStatus(reenter)
    }
    await host.seedSessionTabs(ids)
    expect(sizes).toEqual([2, 3])
    expect(server.builds).toBe(2)
    live('after-session')
    expect(sizes).toEqual([2, 3, 4])
  }
)

it('flushes a committed prefix on lookup error, releases the scope and retries only later eligible rows', async () => {
  const { host, ids, store, server, live } = await savedRosterRig(3)
  const sizes: number[] = []
  server.subscribeStatusChanges((rows) => sizes.push(rows.length))
  const failureBeforeOutput = new Error('recovery lookup failed')
  const getRecord = vi.spyOn(store, 'getRecord').mockImplementationOnce(() => {
    throw failureBeforeOutput
  })
  await expect(host.seedSessionTabs(ids)).rejects.toBe(failureBeforeOutput)
  expect(sizes).toEqual([])
  getRecord.mockRestore()
  const get = store.getConversation
  const failure = new Error('lookup failed')
  const read = vi.spyOn(store, 'getConversation').mockImplementation((id) => {
    if (id === ids[1]) {
      throw failure
    }
    return get(id)
  })
  await expect(host.seedSessionTabs(ids)).rejects.toBe(failure)
  expect(sizes).toEqual([1])
  live()
  expect(sizes).toEqual([1, 2])
  read.mockRestore()
  await host.seedSessionTabs(ids)
  expect(sizes).toEqual([1, 2, 4])
})

it('isolates a caught sink error and listener exceptions, retaining later rows and normal live delivery', async () => {
  const { host, ids, sink, server, live } = await savedRosterRig(3)
  const group = sink.withSavedStatusGroup
  vi.spyOn(sink, 'withSavedStatusGroup').mockImplementation((visit) =>
    group((publisher) =>
      visit({
        ...publisher,
        publish: (summary, subject) => {
          if (summary.sessionId === ids[1]) {
            throw new Error('sink failed')
          }
          publisher.publish(summary, subject)
        }
      })
    )
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
  server.subscribeStatusChanges(() => {
    throw new Error('observer failed')
  })
  const sizes: number[] = []
  server.subscribeStatusChanges((rows) => sizes.push(rows.length))
  await host.seedSessionTabs(ids)
  expect(sizes).toEqual([2])
  live()
  expect(sizes).toEqual([2, 3])
})

it('groups real removal to an empty roster without manufacturing empty/no-op events', async () => {
  const { server, sink, rows } = await savedRosterRig(1)
  const record = rows[0]!
  const subject = makeStructuredAgentStatusSubject(record.location, record.sessionId)
  const sizes: number[] = []
  server.subscribeStatusChanges((roster) => sizes.push(roster.length))
  sink.withSavedStatusGroup(() => {})
  sink.withSavedStatusGroup((publisher) =>
    publisher.publish(
      {
        sessionId: record.sessionId,
        workspaceId: record.location.workspaceId,
        agent: 'claude',
        status: null,
        latestPrompt: '',
        updatedAt: 100
      },
      subject
    )
  )
  expect(sizes).toEqual([])
  server.ingestStructuredStatus(
    {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      agent: 'claude',
      status: 'idle',
      latestPrompt: '',
      updatedAt: 100
    },
    subject
  )
  sink.withSavedStatusGroup((publisher) => publisher.forget(subject))
  expect(sizes).toEqual([1, 0])
})
