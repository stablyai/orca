import {
  applySleepingMailChange,
  type SleepingMailChange
} from '../../../../../shared/workspace/lifecycle/sleeping-mail-change'
import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import {
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { SleepingMailRecordIndex } from './sleeping-mail-record-index'
import { SleptMailboxWake } from './slept-mailbox-wake'
import { reconcileSleepingMail } from './sleeping-mail-owner-mailboxes'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** The held workspaces the window ends up with after every notice it was sent. */
function heldWorkspaces(bell: { mock: { calls: [SleepingMailChange][] } }): string[] {
  const held = new Set<string>()
  for (const [change] of bell.mock.calls) {
    applySleepingMailChange(held, change)
  }
  return [...held].sort()
}

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

function fixture(
  db: OrchestrationDb,
  records: Record<string, SleepingAgentSessionRecord> = {},
  resumes = false
) {
  const sessions = new Map<ExecutionHostId, ReturnType<typeof getDefaultWorkspaceSession>>([
    ['local', { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: records }]
  ])
  const listeners = new Set<(host: ExecutionHostId | null) => void>()
  const bell = vi.fn<(change: SleepingMailChange) => void>()
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
    resumeSleepingAgents: vi.fn(async () => resumes)
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

it('moves a sleeping hold with a real owner transfer and drops it on removal', async () => {
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
    // Mail waiting at startup reaches the sleeper through the restored-mail repoint.
    await vi.waitFor(() => expect(heldWorkspaces(bell)).toEqual(['folder:projection']), {
      timeout: 3_000
    })
    write({
      [pane]: sleeper,
      [otherPane]: { ...sleeper, paneKey: otherPane, worktreeId: 'folder:new' }
    })
    await settled()
    db.bindRun({ runId: run.id, coordinatorHandle: 'term_new', coordinatorPaneKey: otherPane })
    // An unnamed ownership change re-checks the mailboxes already owed to sleepers.
    await vi.waitFor(() => expect(heldWorkspaces(bell)).toEqual(['folder:new']), {
      timeout: 2_000
    })
    write({})
    await settled()
    expect(heldWorkspaces(bell)).toEqual([])
    expect(await runtime.readSleepingMailHold(mailbox)).toBeNull()
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})

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
    reconcileSleepingMail(delivery, index.records.keys(), () => [])
    for (const key of index.records.keys()) {
      for (const mailbox of delivery.mailboxesForPane(key)) {
        delivery.request(mailbox)
      }
    }
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
    db.markAsRead([message.id], { kind: 'orca' })
    reconcileSleepingMail(delivery, index.records.keys(), () => [])
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
    // The restored-mail repoint redelivers mail that arrived before the pane slept.
    delivery.request(`run:${run.id}`)
    await settled()
    expect(wake).toHaveBeenCalledTimes(2)
    db.markAsRead([next.id], { kind: 'orca' })
    reconcileSleepingMail(delivery, index.records.keys(), () => [])
    observe({})
    expect(delivery.heldWorktrees()).toEqual([])
    expect(delivery.hasTrackedMail).toBe(false)
  } finally {
    stop()
    db.close()
  }
})

it('releases a wake the window accepted but never launched, so later mail can wake the pane', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'unlaunched',
    coordinatorHandle: 'term',
    coordinatorPaneKey: pane
  })
  const { runtime } = fixture(db, { [pane]: { ...sleeper, restoreOnTabOpenOnly: false } }, true)
  try {
    await runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'owed' })
    await vi.waitFor(() => expect(db.listMailWakeAttempts()).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(31_000)
    expect(db.listMailWakeAttempts()).toEqual([])
  } finally {
    runtime.setNotifier(null)
    db.close()
    vi.useRealTimers()
  }
})
