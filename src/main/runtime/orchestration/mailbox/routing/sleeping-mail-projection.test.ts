import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { publishAgentSessionCrewChanges } from '../../../agent-session/records/agent-session-crew-invalidation'
import { agentSessionStoreDraftRowWrites } from '../../../agent-session/records/agent-session-store-draft'
import type { AgentSessionStoreState } from '../../../agent-session/records/agent-session-store-state'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { parseOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import { SleptMailboxWake } from './slept-mailbox-wake'
import { sleepingMailOwnerMailboxes } from './sleeping-mail-owner-mailboxes'

const pane = 'tab:11111111-1111-4111-8111-111111111111'
const otherPane = 'other:22222222-2222-4222-8222-222222222222'
const sleeper: SleepingAgentSessionRecord = {
  paneKey: pane,
  tabId: 'tab',
  worktreeId: 'folder:projection',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'conversation' },
  prompt: '',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1,
  restoreOnTabOpenOnly: true
}
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

function changeSessionTopology() {
  const record = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId: 'session-history' })
  )
  const published: AgentSessionStoreState = {
    records: new Map([[record.sessionId, record]]),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
  const draft = {
    ...published,
    records: new Map([
      [
        record.sessionId,
        {
          ...record,
          location: { ...record.location, workspaceId: 'another-workspace' }
        }
      ]
    ])
  }
  const writes = agentSessionStoreDraftRowWrites(published, draft)
  if (writes) {
    publishAgentSessionCrewChanges(published, draft, writes)
  }
}

function fixture(db: OrchestrationDb, records: Record<string, SleepingAgentSessionRecord> = {}) {
  const sessions = new Map<ExecutionHostId, ReturnType<typeof getDefaultWorkspaceSession>>([
    ['local', { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: records }]
  ])
  const listeners = new Set<(host: ExecutionHostId | null) => void>()
  const bell = vi.fn()
  const notifier: RuntimeNotifier = {
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn(),
    sleepingMailChanged: bell,
    resumeSleepingAgents: vi.fn(async () => false)
  }
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getWorkspaceSession: (host) =>
        sessions.get(parseExecutionHostId(host)?.id ?? 'local') ?? getDefaultWorkspaceSession(),
      getWorkspaceSessionHostIds: () => [...sessions.keys()],
      onWorkspaceSessionWritten: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
  )
  runtime.setNotifier(notifier)
  runtime.setOrchestrationDb(db)
  return {
    runtime,
    bell,
    removeHost(host: ExecutionHostId) {
      sessions.delete(host)
      for (const listener of listeners) {
        listener(null)
      }
    },
    write(records: Record<string, SleepingAgentSessionRecord>, host: ExecutionHostId = 'local') {
      sessions.set(host, {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: records
      })
      for (const listener of listeners) {
        listener(host)
      }
    }
  }
}

it.each([10, 100])(
  'does no wake discovery on real traffic/topology with no interest and %i runs per handle',
  async (count) => {
    const db = new OrchestrationDb(':memory:')
    const runs = Array.from({ length: count }, () =>
      db.createRun({
        objective: 'handle history',
        coordinatorHandle: 'term_history',
        coordinatorPaneKey: pane,
        coordinatorOrcaSessionId: parseOrcaSessionAddress('orca_session_id:session-history')
      })
    )
    const { runtime } = fixture(db)
    try {
      await settled()
      const prepare = vi.spyOn(db.db, 'prepare')
      const getRun = vi.spyOn(db, 'getRun')
      const requireRun = vi.spyOn(db, 'requireRun')
      const discover = vi.spyOn(SleptMailboxWake.prototype, 'discover')
      const addresses = ['term_history', 'orca_session_id:session-history']
      for (const address of addresses) {
        requireRun.mockClear()
        db.insertMessage({
          runId: runs[0]!.id,
          from: address,
          to: address,
          subject: 'ordinary mail'
        })
        expect(requireRun.mock.calls).toEqual([[runs[0]!.id]])
        // The insert's primary-key requireRun read is separate from owner/discovery reads.
        const baseline = getRun.mock.calls.length
        await settled()
        expect(getRun.mock.calls.length).toBe(baseline)
        changeSessionTopology()
        await settled()
        expect(getRun.mock.calls.length).toBe(baseline)
      }
      expect(discover).not.toHaveBeenCalled()
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH candidates'))).toEqual([])
      await expect(runtime.readSleepingMailHold('term_history')).resolves.toBeNull()
    } finally {
      vi.restoreAllMocks()
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it.each([10, 100])(
  'one remote obligation does not expose %i unrelated historical owners',
  async (count) => {
    const db = new OrchestrationDb(':memory:')
    const runs = Array.from({ length: count }, () =>
      db.createRun({
        objective: 'unrelated',
        coordinatorHandle: 'term_history',
        coordinatorPaneKey: pane
      })
    )
    const { runtime, write, bell, removeHost } = fixture(db)
    try {
      await settled()
      const remoteRun = db.createRun({
        objective: 'relevant remote obligation',
        coordinatorHandle: 'term_remote',
        coordinatorPaneKey: otherPane
      })
      db.insertMessage({
        runId: remoteRun.id,
        from: 'worker',
        to: `run:${remoteRun.id}`,
        subject: 'remote mail'
      })
      write(
        { [otherPane]: { ...sleeper, paneKey: otherPane, connectionId: 'remote' } },
        'ssh:remote'
      )
      await settled()
      await settled()
      const getRun = vi.spyOn(db, 'getRun')
      const newest = vi.spyOn(db, 'getUndeliveredUnreadSequence')
      const inventory = vi.spyOn(db, 'getUndeliveredUnreadMailboxHandles')
      const prepare = vi.spyOn(db.db, 'prepare')
      db.insertMessage({
        runId: runs[0]!.id,
        from: 'term_history',
        to: 'term_history',
        subject: 'mail'
      })
      getRun.mockClear()
      await settled()
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH candidates'))).toEqual([])
      // This message's Run scope needs one current owner read; unrelated history contributes none.
      expect(getRun.mock.calls).toEqual([[runs[0]!.id]])
      changeSessionTopology()
      await settled()
      expect(getRun.mock.calls).toEqual([[runs[0]!.id]])
      expect(newest).not.toHaveBeenCalled()
      expect(inventory).not.toHaveBeenCalled()
      expect(bell).toHaveBeenLastCalledWith(['folder:projection'])
      removeHost('ssh:remote')
      await settled()
      expect(bell).toHaveBeenLastCalledWith([])
    } finally {
      vi.restoreAllMocks()
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it.each([10, 100])(
  'a changed pane discovers eligible old mail without walking %i historical runs',
  async (count) => {
    const db = new OrchestrationDb(':memory:')
    const runs = Array.from({ length: count }, () =>
      db.createRun({
        objective: 'pane history',
        coordinatorHandle: 'term_history',
        coordinatorPaneKey: pane
      })
    )
    const oldest = runs[0]!
    const mailbox = `run:${oldest.id}`
    db.insertMessage({
      runId: oldest.id,
      from: 'worker',
      to: mailbox,
      subject: 'old but deliverable'
    })
    for (const run of runs.slice(1)) {
      const row = db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: `run:${run.id}`,
        subject: 'consumed'
      })
      db.markAsRead([row.id])
    }
    const { runtime, write, bell } = fixture(db)
    try {
      await settled()
      const getRun = vi.spyOn(db, 'getRun')
      const newest = vi.spyOn(db, 'getUndeliveredUnreadSequence')
      const prepare = vi.spyOn(db.db, 'prepare')
      write({ [pane]: sleeper })
      await settled()
      expect(bell).toHaveBeenLastCalledWith(['folder:projection'])
      expect(newest.mock.calls.map(([address]) => address)).toEqual([mailbox, mailbox, mailbox])
      // Refresh, request and batch each resolve this one candidate; no history-dependent lookup.
      expect(new Set(getRun.mock.calls.map(([id]) => id))).toEqual(new Set([oldest.id]))
      expect(getRun.mock.calls.length).toBeLessThanOrEqual(5)
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH candidates'))).toHaveLength(1)
      expect(await runtime.readSleepingMailHold(mailbox)).toMatchObject({ openTab: true })
      newest.mockClear()
      write({ [pane]: { ...sleeper, mailWake: { id: 'custody', capturedAt: 1, startedAt: 2 } } })
      await settled()
      write({})
      await settled()
      expect(bell).toHaveBeenLastCalledWith([])
      getRun.mockClear()
      db.insertMessage({
        runId: oldest.id,
        from: 'term_history',
        to: 'term_history',
        subject: 'after cleanup'
      })
      getRun.mockClear()
      await settled()
      expect(getRun).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it.each([10, 100])(
  'equivalent session snapshots for %i sleepers/live/quit panes have no downstream callbacks',
  async (count) => {
    const db = new OrchestrationDb(':memory:')
    const records = Object.fromEntries(
      Array.from({ length: count * 3 }, (_, i) => {
        const paneKey = `pane-${i}`
        return [
          paneKey,
          {
            ...sleeper,
            paneKey,
            origin: i < count ? 'worktree-sleep' : i < count * 2 ? 'live' : 'quit'
          }
        ]
      })
    ) as Record<string, SleepingAgentSessionRecord>
    const { runtime, write } = fixture(db, records)
    try {
      await settled()
      const discover = vi.spyOn(SleptMailboxWake.prototype, 'discover')
      const callback = vi.spyOn(SleptMailboxWake.prototype, 'refreshPane')
      const prepare = vi.spyOn(db.db, 'prepare')
      const equivalent = structuredClone(records)
      for (const record of Object.values(equivalent)) {
        record.updatedAt++
      }
      write(equivalent)
      await settled()
      expect(discover).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
      // An ordinary live/quit record changing presentation still cannot create an obligation.
      write(
        Object.fromEntries(
          Object.entries(equivalent).map(([key, value]) => [key, { ...value, prompt: 'new title' }])
        )
      )
      await settled()
      expect(discover).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
      write({ ...equivalent, 'pane-0': { ...equivalent['pane-0']!, capturedAt: 2 } })
      await settled()
      expect(discover.mock.calls).toEqual([['pane-0']])
      expect(callback.mock.calls).toEqual([['pane-0']])
    } finally {
      vi.restoreAllMocks()
      runtime.setNotifier(null)
      db.close()
    }
  }
)

it('updates equivalent references, maintains invocation-only changes, and scopes a real owner transfer/removal', async () => {
  const index = new SleepingMailRecordIndex()
  const callback = vi.fn()
  index.refresh('remote', { [pane]: sleeper }, callback)
  index.changed.clear()
  callback.mockClear()
  const equivalent = structuredClone(sleeper)
  index.refresh('remote', { [pane]: equivalent }, callback)
  expect(index.records.get(pane)).toBe(equivalent)
  expect(callback).not.toHaveBeenCalled()
  index.refresh(
    'remote',
    { [pane]: { ...equivalent, mailWake: { id: 'marker', capturedAt: 1, startedAt: 2 } } },
    callback
  )
  index.changed.clear()
  callback.mockClear()
  index.refresh(
    'remote',
    {
      [pane]: {
        ...equivalent,
        mailWake: {
          id: 'marker',
          capturedAt: 1,
          startedAt: 2,
          attempt: { ptyId: 'pty', incarnationId: 'inc', launchToken: 'token', startedAt: 3 }
        }
      }
    },
    callback
  )
  expect(callback.mock.calls).toEqual([[pane]])
  expect([...index.changed]).toEqual([])

  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'transfer',
    coordinatorHandle: 'term_old',
    coordinatorPaneKey: pane
  })
  const mailbox = `run:${run.id}`
  db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'owed' })
  const { runtime, write, bell } = fixture(db, { [pane]: sleeper })
  try {
    await settled()
    expect(bell).toHaveBeenLastCalledWith(['folder:projection'])
    write({
      [pane]: sleeper,
      [otherPane]: { ...sleeper, paneKey: otherPane, worktreeId: 'folder:new' }
    })
    await settled()
    db.bindRun({ runId: run.id, coordinatorHandle: 'term_new', coordinatorPaneKey: otherPane })
    await settled()
    expect(bell).toHaveBeenLastCalledWith(['folder:new'])
    write({})
    await settled()
    expect(bell).toHaveBeenLastCalledWith([])
    expect(await runtime.readSleepingMailHold(mailbox)).toBeNull()
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})

it.each([10, 100])(
  'populated discovery plans lead eligible mail, not %i historical owner rows',
  (count) => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runs = Array.from({ length: count }, () =>
        db.createRun({
          objective: 'history',
          coordinatorHandle: 'term_history',
          coordinatorPaneKey: pane
        })
      )
      const first = runs[0]!
      db.insertMessage({
        runId: first.id,
        from: 'worker',
        to: `run:${first.id}`,
        subject: 'eligible'
      })
      for (let i = 0; i < count; i++) {
        db.db
          .prepare(`INSERT INTO remote_dispatch_attachments
          (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, pane_key, state, terminal_handle)
          VALUES (?, 'task', 'peer', 'epoch', ?, 'ready', 'term_history')`)
          .run(`remote-${i}`, pane)
      }
      db.insertMessage({
        runId: first.id,
        from: 'worker',
        to: 'dispatch:remote-0',
        subject: 'remote eligible'
      })
      db.db.exec('ANALYZE')
      const prepare = vi.spyOn(db.db, 'prepare')
      expect(sleepingMailOwnerMailboxes(db, pane)).toEqual([`run:${first.id}`, 'dispatch:remote-0'])
      const sql = prepare.mock.calls.find(([sql]) => sql.includes('WITH candidates'))![0]
      prepare.mockRestore()
      const plans = db.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(pane.slice(4), pane.slice(4), pane.slice(4))
        .map((row) => String(row.detail))
      expect(plans.some((detail) => detail.includes('idx_messages_mail_wake_candidate'))).toBe(true)
      expect(
        plans.filter((detail) =>
          /SCAN (runs|dispatch_contexts|remote_dispatch_attachments)/.test(detail)
        )
      ).toEqual([])
      expect(plans.some((detail) => /SEARCH runs .*\(id=\?\)/.test(detail))).toBe(true)
      expect(plans.some((detail) => /SEARCH dispatch_contexts .*\(id=\?\)/.test(detail))).toBe(true)
      expect(plans).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/SEARCH remote_dispatch_attachments .*\(dispatch_id=\?\)/)
        ])
      )
      const addressQuery = vi.spyOn(db.db, 'prepare')
      expect(sleepingMailOwnerMailboxes(db, null, 'term_history')).toEqual([
        `run:${first.id}`,
        'dispatch:remote-0'
      ])
      const addressSql = addressQuery.mock.calls.find(([sql]) =>
        sql.includes('WITH candidates')
      )![0]
      addressQuery.mockRestore()
      const addressPlans = db.db
        .prepare(`EXPLAIN QUERY PLAN ${addressSql}`)
        .all('term_history', null, 'term_history', null, 'term_history')
        .map((row) => String(row.detail))
      expect(
        addressPlans.filter((detail) =>
          /SCAN (runs|dispatch_contexts|remote_dispatch_attachments)/.test(detail)
        )
      ).toEqual([])
      expect(addressPlans).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/SEARCH runs .*\(id=\?\)/),
          expect.stringMatching(/SEARCH remote_dispatch_attachments .*\(dispatch_id=\?\)/)
        ])
      )
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)

it('keeps same-sequence success through record replacement/removal and releases it on real consumption', async () => {
  const db = new OrchestrationDb(':memory:')
  const index = new SleepingMailRecordIndex()
  const wake = vi.fn(async () => true)
  const delivery = new SleptMailboxWake({
    db: () => db,
    record: (key) => index.records.get(key) ?? null,
    waiters: () => undefined,
    prepare: async () => {},
    wake
  })
  const observe = (records: Record<string, SleepingAgentSessionRecord>) => {
    index.refresh('local', records, (pane) => delivery.refreshPane(pane))
    for (const key of index.changed) {
      for (const mailbox of new Set([
        ...delivery.mailboxesForPane(key),
        ...delivery.discover(key)
      ])) {
        delivery.request(mailbox)
      }
    }
    index.changed.clear()
  }
  const stop = db.crewChanges.subscribe((facets) => {
    for (const address of facets.trafficAddresses ?? []) {
      if (address.startsWith('run:')) {
        delivery.request(address)
      }
    }
  })
  try {
    const run = db.createRun({
      objective: 'suppression',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: pane
    })
    const automatic = { ...sleeper, restoreOnTabOpenOnly: false }
    observe({ [pane]: automatic })
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'unconsumed'
    })
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    observe({})
    observe({ [pane]: structuredClone(automatic) })
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    db.markAsRead([message.id])
    expect(delivery.heldWorktrees()).toEqual([])
    expect(delivery.hasTrackedMail).toBe(false)
    observe({})
    const next = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'mail before new obligation'
    })
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    observe({ [pane]: { ...automatic, capturedAt: 2 } })
    await settled()
    expect(wake).toHaveBeenCalledTimes(2)
    db.markAsRead([next.id])
    observe({})
    expect(delivery.heldWorktrees()).toEqual([])
    expect(delivery.hasTrackedMail).toBe(false)
  } finally {
    stop()
    db.close()
  }
})
