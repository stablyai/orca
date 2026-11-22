import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { scopedCrewChange } from '../../crew/crew-changes'
import { countDiscoveryRows } from './sleeping-mail-discovery-work.test-fixture'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { reconcileSleepingMail } from './sleeping-mail-owner-mailboxes'
import { SleptMailboxWake } from './slept-mailbox-wake'

const sleeper = (index: number, worktreeId: string): SleepingAgentSessionRecord => ({
  paneKey: `tab:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`,
  tabId: 'tab',
  worktreeId,
  agent: 'codex',
  providerSession: { key: 'session_id', id: `conversation-${index}` },
  prompt: '',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1,
  restoreOnTabOpenOnly: true
})

it.each([100, 1_000])(
  'a pane joining or leaving an already-held workspace leaves the held set unpublished (%i held)',
  (held) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const records = new Map<string, SleepingAgentSessionRecord>()
      const owe = (record: SleepingAgentSessionRecord) => {
        records.set(record.paneKey, record)
        const run = db.createRun({
          objective: record.paneKey,
          coordinatorHandle: null,
          coordinatorPaneKey: record.paneKey
        })
        db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
      }
      for (let index = 0; index < held; index += 1) {
        owe(sleeper(index, `folder:${index}`))
      }
      const delivery = new SleptMailboxWake({
        db: () => db,
        record: (paneKey) => records.get(paneKey) ?? null,
        waiters: () => undefined,
        prepare: async () => {},
        wake: async () => false
      })
      reconcileSleepingMail(delivery, db, records.keys(), () => undefined)
      expect(delivery.heldWorktrees()).toHaveLength(held)
      const version = delivery.heldVersion

      const joining = sleeper(held, 'folder:0')
      owe(joining)
      reconcileSleepingMail(delivery, db, [joining.paneKey], () => undefined)
      expect(delivery.heldVersion).toBe(version)
      records.delete(joining.paneKey)
      delivery.refreshPane(joining.paneKey)
      expect(delivery.heldVersion).toBe(version)

      const first = sleeper(held + 1, 'folder:new')
      owe(first)
      reconcileSleepingMail(delivery, db, [first.paneKey], () => undefined)
      expect(delivery.heldVersion).toBe(version + 1)
      expect(delivery.heldWorktrees()).toHaveLength(held + 1)
    } finally {
      db.close()
    }
  }
)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([100, 1_000])(
  'orchestration changes that name no sleeper seek no sleeper owner range (%i sleepers)',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < count; index += 1) {
      const record = { ...sleeper(index, `folder:${index}`), restoreOnTabOpenOnly: false }
      sleepingAgentSessionsByPaneKey[record.paneKey] = record
      db.createRun({
        objective: 'old',
        coordinatorHandle: null,
        coordinatorPaneKey: record.paneKey
      })
    }
    const session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    const resumeSleepingAgents = async () => true
    const members: Partial<RuntimeNotifier> = { resumeSleepingAgents }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass under test calls only resumeSleepingAgents; every other member is a no-op.
    const notifier = new Proxy(members, {
      get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn())
    }) as RuntimeNotifier
    try {
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(2_000)
      const work = countDiscoveryRows(db)

      db.crewChanges.notify(scopedCrewChange(['topology'], { dispatchIds: new Set(['unowned']) }))
      await vi.advanceTimersByTimeAsync(2_000)
      db.crewChanges.notify(new Set(['traffic']))
      await vi.advanceTimersByTimeAsync(2_000)

      expect(work.owners).toEqual([])
      expect(work.probes).toEqual([])
      work.stop()
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it.each([1_000, 10_000])(
  'availability edges and unnamed changes read no owner of %i stranded mailboxes',
  async (stranded) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const record = { ...sleeper(0, 'folder:0'), restoreOnTabOpenOnly: false }
    const run = db.createRun({
      objective: 'finished',
      coordinatorHandle: null,
      coordinatorPaneKey: 'tab:00000000-2222-4222-8222-222222222222'
    })
    for (let index = 0; index < stranded; index += 1) {
      db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: `dispatch:gone-${index}`,
        subject: 'x'
      })
    }
    const session = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    const resumeSleepingAgents = async () => true
    const members: Partial<RuntimeNotifier> = { resumeSleepingAgents }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass under test calls only resumeSleepingAgents; every other member is a no-op.
    const notifier = new Proxy(members, {
      get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn())
    }) as RuntimeNotifier
    try {
      const reads = [
        vi.spyOn(db, 'getRun'),
        vi.spyOn(db, 'getDispatchContextById'),
        vi.spyOn(db, 'getRemoteDispatchAttachment')
      ]
      const prepare = vi.spyOn(db.db, 'prepare')
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      for (let tick = 0; tick < 10; tick += 1) {
        // Availability edges re-check every sleeper; unnamed changes re-check nothing.
        runtime.retrySleptMailboxWakes()
        db.crewChanges.notify(new Set(['traffic']))
        db.crewChanges.notify()
        await vi.advanceTimersByTimeAsync(1_000)
      }

      expect(reads.map((read) => read.mock.calls.length)).toEqual([0, 0, 0])
      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes('SELECT DISTINCT to_handle'))
      ).toEqual([])
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)
