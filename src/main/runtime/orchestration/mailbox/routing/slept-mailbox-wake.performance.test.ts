import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { scopedCrewChange } from '../../crew/crew-changes'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
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
        return `run:${run.id}`
      }
      const mailboxes: string[] = []
      for (let index = 0; index < held; index += 1) {
        mailboxes.push(owe(sleeper(index, `folder:${index}`)))
      }
      const delivery = new SleptMailboxWake({
        db: () => db,
        record: (paneKey) => records.get(paneKey) ?? null,
        waiters: () => undefined,
        prepare: async () => {},
        wake: async () => false
      })
      for (const mailbox of mailboxes) {
        delivery.refresh(mailbox)
      }
      expect(delivery.heldWorktrees()).toHaveLength(held)
      const version = delivery.heldVersion

      const joining = sleeper(held, 'folder:0')
      delivery.refresh(owe(joining))
      expect(delivery.heldVersion).toBe(version)
      records.delete(joining.paneKey)
      delivery.refreshPane(joining.paneKey)
      expect(delivery.heldVersion).toBe(version)

      const first = sleeper(held + 1, 'folder:new')
      delivery.refresh(owe(first))
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
  'orchestration changes that name no sleeper read only what they name (%i sleepers)',
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
      const reads = [
        vi.spyOn(db, 'getRun'),
        vi.spyOn(db, 'getDispatchContextById'),
        vi.spyOn(db, 'getRemoteDispatchAttachment')
      ]

      db.crewChanges.notify(scopedCrewChange(['topology'], { dispatchIds: new Set(['unowned']) }))
      await vi.advanceTimersByTimeAsync(2_000)
      db.crewChanges.notify(new Set(['traffic']))
      await vi.advanceTimersByTimeAsync(2_000)

      // Only the named Dispatch is read, whatever the number of sleepers.
      expect(reads.map((read) => read.mock.calls.length)).toEqual([0, 1, 1])
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
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      // Opening the database repoints restored mail once (unchanged by sleep); count after it.
      await vi.advanceTimersByTimeAsync(5_000)
      const reads = [
        vi.spyOn(db, 'getRun'),
        vi.spyOn(db, 'getDispatchContextById'),
        vi.spyOn(db, 'getRemoteDispatchAttachment')
      ]
      const prepare = vi.spyOn(db.db, 'prepare')
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

it.each([100, 1_000])(
  'with nobody asleep, %i mail reads do no sleeping-mail lookups',
  async (reads) => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => getDefaultWorkspaceSession(),
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    try {
      runtime.setOrchestrationDb(db)
      runtime.retrySleptMailboxWakes()
      const run = db.createRun({
        objective: 'awake',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      const ids = Array.from(
        { length: reads },
        () =>
          db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'x' }).id
      )
      const prepare = vi.spyOn(db.db, 'prepare')

      for (const id of ids) {
        db.markAsRead([id], { kind: 'orca' })
      }

      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes('SELECT DISTINCT to_handle'))
      ).toEqual([])
    } finally {
      db.close()
    }
  }
)

it.each([100, 1_000])(
  'a runtime environment becoming available re-checks no inbox of %i sleepers owed nothing',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < count; index += 1) {
      const record = { ...sleeper(index, `folder:${index}`), terminalHandle: `term_${index}` }
      sleepingAgentSessionsByPaneKey[record.paneKey] = { ...record, restoreOnTabOpenOnly: false }
    }
    const session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    try {
      runtime.setOrchestrationDb(db)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(5_000)
      const inboxChecks = vi.spyOn(SleptMailboxWake.prototype, 'refresh')

      for (let edge = 0; edge < 10; edge += 1) {
        runtime.retrySleptMailboxWakes(undefined, true)
        await vi.advanceTimersByTimeAsync(1_000)
      }

      expect(inboxChecks).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  }
)

it.each([50, 500])(
  'an unnamed orchestration change re-reads each of %i owed mailboxes once and republishes nothing',
  async (owed) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < owed; index += 1) {
      // Workspace Sleep panes stay owed until opened, and never start a wake.
      const record = sleeper(index, `folder:${index}`)
      sleepingAgentSessionsByPaneKey[record.paneKey] = record
      const run = db.createRun({
        objective: 'owed',
        coordinatorHandle: null,
        coordinatorPaneKey: record.paneKey
      })
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'x' })
    }
    const session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    const bell = vi.fn()
    const members: Partial<RuntimeNotifier> = { sleepingMailChanged: bell }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the passes under test call only sleepingMailChanged; every other member is a no-op.
    const notifier = new Proxy(members, {
      get: (_target, key) => (key === 'sleepingMailChanged' ? bell : vi.fn())
    }) as RuntimeNotifier
    try {
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(5_000)
      const refreshes = vi.spyOn(SleptMailboxWake.prototype, 'refresh')
      bell.mockClear()

      db.crewChanges.notify(new Set(['traffic']))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(refreshes.mock.calls.length).toBeLessThanOrEqual(owed)
      for (let edge = 0; edge < 10; edge += 1) {
        runtime.retrySleptMailboxWakes(undefined, true)
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(bell).not.toHaveBeenCalled()
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it('one pane going to sleep retries only its own failed wake', async () => {
  const db = new OrchestrationDb(':memory:')
  const records = new Map<string, SleepingAgentSessionRecord>()
  const wake = vi.fn(async () => false)
  try {
    const mailboxes = [0, 1].map((index) => {
      const record = { ...sleeper(index, `folder:${index}`), restoreOnTabOpenOnly: false }
      records.set(record.paneKey, record)
      const run = db.createRun({
        objective: 'owed',
        coordinatorHandle: null,
        coordinatorPaneKey: record.paneKey
      })
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'x' })
      return `run:${run.id}`
    })
    const delivery = new SleptMailboxWake({
      db: () => db,
      record: (paneKey) => records.get(paneKey) ?? null,
      waiters: () => undefined,
      prepare: async () => {},
      wake
    })
    mailboxes.forEach((mailbox) => delivery.request(mailbox))
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))

    for (let notice = 0; notice < 10; notice += 1) {
      delivery.retryFailed(sleeper(1, 'folder:1').paneKey)
      delivery.request(mailboxes[0])
    }
    await Promise.resolve()

    expect(wake).toHaveBeenCalledTimes(2)
  } finally {
    db.close()
  }
})

it.each([100, 1_000])(
  'one pane’s availability retry reads none of %i tracked mailboxes',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < count; index += 1) {
      const record = { ...sleeper(index, `folder:${index}`), restoreOnTabOpenOnly: false }
      sleepingAgentSessionsByPaneKey[record.paneKey] = record
      const run = db.createRun({
        objective: 'owed',
        coordinatorHandle: null,
        coordinatorPaneKey: record.paneKey
      })
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
    }
    const session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    const resumeSleepingAgents = async () => false
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass under test calls only resumeSleepingAgents; every other member is a no-op.
    const notifier = new Proxy(
      {},
      { get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn()) }
    ) as RuntimeNotifier
    try {
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(2_000)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tracked-mailbox read is the work under test.
      const wakes = (runtime as unknown as { sleptMailboxWake: SleptMailboxWake }).sleptMailboxWake
      const tracked = vi.spyOn(wakes, 'trackedMailboxes')
      for (let retry = 0; retry < 10; retry += 1) {
        runtime.retrySleptMailboxWakes(sleeper(0, 'folder:0').paneKey)
      }
      await vi.advanceTimersByTimeAsync(2_000)
      expect(tracked).not.toHaveBeenCalled()
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it.each([100, 1_000])(
  'an unrelated host reconnect reads none of %i local sleepers’ held mail or failed wakes',
  async (count) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    const db = new OrchestrationDb(':memory:')
    const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
    for (let index = 0; index < count; index += 1) {
      const record = { ...sleeper(index, `repo-local::/w/${index}`), restoreOnTabOpenOnly: false }
      sleepingAgentSessionsByPaneKey[record.paneKey] = record
      const run = db.createRun({
        objective: 'owed',
        coordinatorHandle: null,
        coordinatorPaneKey: record.paneKey
      })
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
    }
    const session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {},
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host check reads only the repo's host fields.
        getRepo: (id: string) => ({ id, connectionId: null }) as never
      })
    )
    const resumeSleepingAgents = vi.fn(async () => false)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pass under test calls only resumeSleepingAgents; every other member is a no-op.
    const notifier = new Proxy(
      {},
      { get: (_target, key) => (key === 'resumeSleepingAgents' ? resumeSleepingAgents : vi.fn()) }
    ) as RuntimeNotifier
    try {
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(notifier)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await vi.advanceTimersByTimeAsync(2_000)
      const prepared = resumeSleepingAgents.mock.calls.length
      expect(prepared).toBeGreaterThan(0)
      const runReads = vi.spyOn(db, 'getRun')
      runtime.retrySleptMailboxWakes(undefined, 'ssh:other-host')
      runtime.retrySleptMailboxWakes(undefined, 'runtime:other-env')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(runReads).not.toHaveBeenCalled()
      expect(resumeSleepingAgents).toHaveBeenCalledTimes(prepared)
      // The sleepers' own host coming back still retries their failed wakes.
      runtime.retrySleptMailboxWakes(undefined, 'local')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(resumeSleepingAgents.mock.calls.length).toBeGreaterThan(prepared)
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it('one mail wake with no waiter reservation reads its Run owner twice before prepare', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const record = { ...sleeper(0, 'folder:0'), restoreOnTabOpenOnly: false }
    const run = db.createRun({
      objective: 'owed',
      coordinatorHandle: null,
      coordinatorPaneKey: record.paneKey
    })
    db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
    const runReads = vi.spyOn(db, 'getRun')
    const sequenceReads = vi.spyOn(db, 'getUndeliveredUnreadSequence')
    const counts: number[] = []
    const delivery = new SleptMailboxWake({
      db: () => db,
      record: (paneKey) => (paneKey === record.paneKey ? record : null),
      waiters: () => undefined,
      prepare: () => {
        counts.push(runReads.mock.calls.length, sequenceReads.mock.calls.length)
        return new Promise(() => {})
      },
      wake: async () => false
    })
    // The no-consumer delivery hands over the waiters' (empty) reservation set.
    delivery.request(`run:${run.id}`, new Set())
    // One read for the refresh, one for the wake it starts.
    expect(counts).toEqual([2, 2])
  } finally {
    db.close()
  }
})
