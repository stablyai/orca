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
    delivery.reconcile(index.records.keys())
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
    db.markAsRead([message.id])
    delivery.reconcile(index.records.keys())
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
    delivery.reconcile(index.records.keys())
    observe({})
    expect(delivery.heldWorktrees()).toEqual([])
    expect(delivery.hasTrackedMail).toBe(false)
  } finally {
    stop()
    db.close()
  }
})
