import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { ORCHESTRATION_REPLY_METHOD } from '../../../rpc/methods/orchestration/messaging/reply-method'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../../construction/test-context/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/orca-profiles/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { sendDeliveryHoldWarning } from '../../../rpc/methods/orchestration/messaging/send-delivery-hold'
import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SleptMailRecord } from './mail-wake-obligation'
import { SleptMailboxWake } from './slept-mailbox-wake'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const record: SleepingAgentSessionRecord = {
  paneKey,
  tabId: 'tab',
  worktreeId: 'folder:workspace',
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'conversation' },
  prompt: 'coordinate',
  state: 'done',
  origin: 'worktree-sleep',
  capturedAt: 1,
  updatedAt: 1
}
const settled = () => new Promise<void>((resolve) => setImmediate(resolve))

const mailNotifier = (
  resume: RuntimeNotifier['resumeSleepingAgents'],
  bell?: RuntimeNotifier['sleepingMailChanged']
): RuntimeNotifier => ({
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
  resumeSleepingAgents: resume,
  sleepingMailChanged: bell
})

it('wakes only the automatic sleeper owed deliverable mail, coalesces it, and retries a failed wake on availability', async () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'Coordinate',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: paneKey
    })
    const mailbox = `run:${run.id}`
    let sleeping: SleptMailRecord | null = record
    let releaseSleep: () => void = () => {}
    let sleep = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    let wakeSucceeded = true
    const wake = vi.fn(async (target: SleepingAgentSessionRecord) => {
      expect(target.paneKey).toBe('tab:11111111-1111-4111-8111-111111111111')
      return wakeSucceeded
    })
    const delivery = new SleptMailboxWake({
      db: () => db,
      record: () => sleeping,
      waiters: () => undefined,
      prepare: () => sleep,
      wake
    })
    delivery.request(mailbox)
    await settled()
    expect(wake).not.toHaveBeenCalled()

    const first = db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'done' })
    delivery.request('term_old')
    delivery.request(mailbox)
    delivery.request(mailbox)
    await settled()
    expect(wake).not.toHaveBeenCalled()
    releaseSleep()
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    expect(db.getMessageById(first.id)?.read).toBe(0)
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)

    const burst = Array.from({ length: 50 }, () =>
      db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'burst' })
    )
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(2)
    const beyondBatch = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'after a full unconsumed batch'
    })
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(3)
    db.markAsRead([first.id, beyondBatch.id, ...burst.map((message) => message.id)])
    const second = db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'more' })
    sleeping = { ...record, restoreOnTabOpenOnly: true }
    delivery.request(mailbox)
    sleeping = { ...record, state: 'working' }
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(3)

    // A sleep record can arrive after mail and the PTY's exit have already been processed.
    sleeping = null
    delivery.request(mailbox)
    await settled()
    sleeping = record
    sleep = Promise.resolve()
    wakeSucceeded = false
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(4)
    expect(db.getMessageById(second.id)?.read).toBe(0)
    wakeSucceeded = true
    delivery.request(mailbox)
    await settled()
    // A failed wake waits for an availability edge rather than retrying on every notice.
    expect(wake).toHaveBeenCalledTimes(4)
    delivery.retryFailed()
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(5)

    db.markAsRead([second.id])
    const third = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'checked during sleep'
    })
    sleep = new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
    delivery.request(mailbox)
    db.markAsRead([third.id])
    releaseSleep()
    await settled()
    expect(wake).toHaveBeenCalledTimes(5)
  } finally {
    db.close()
  }
})

it('holds manual Sleep through the sender receipt and keeps its bell until mail is consumed', async () => {
  const db = new OrchestrationDb(':memory:')
  const manual = { ...record, restoreOnTabOpenOnly: true }
  const session = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: { [paneKey]: manual }
  }
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local']
    })
  )
  const resume = vi.fn(async () => true)
  const bell = vi.fn()
  const notifier = mailNotifier(resume, bell)
  try {
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'Manual sleep',
      coordinatorHandle: 'term_asleep',
      coordinatorPaneKey: paneKey
    })
    const mailbox = `run:${run.id}`
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'done'
    })
    runtime.deliverPendingMessagesForHandle(mailbox)
    await settled()
    expect(resume).not.toHaveBeenCalled()
    expect(await runtime.readSleepingMailHold(mailbox)).toMatchObject({
      kind: 'asleep',
      openTab: true
    })
    expect(await sendDeliveryHoldWarning(runtime, db, mailbox)).toMatchObject({
      code: 'recipient_delivery_held',
      recipient: mailbox
    })
    expect(bell).toHaveBeenLastCalledWith(['folder:workspace'])
    db.markAsRead([message.id])
    runtime.withdrawStaleChatMail([mailbox])
    await settled()
    expect(bell).toHaveBeenLastCalledWith([])
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})

it('suppresses a definitively confirmed late wake only for its obligation and releases consumed mailbox retention', async () => {
  const db = new OrchestrationDb(':memory:')
  let sleeping: SleepingAgentSessionRecord | null = record
  const wake = vi.fn(async () => false)
  const delivery = new SleptMailboxWake({
    db: () => db,
    record: () => sleeping,
    waiters: () => undefined,
    prepare: async () => {},
    wake
  })
  try {
    const run = db.createRun({
      objective: 'late confirmation',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: paneKey
    })
    const mailbox = `run:${run.id}`
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'done'
    })
    delivery.request(mailbox)
    await settled()
    const retained: SleptMailRecord = { ...record, mailWake: { id: 'obligation', startedAt: 100 } }
    sleeping = retained
    delivery.confirmed({ ...retained, capturedAt: 2 })
    expect(delivery.failedToWake(retained)).toBe(true)
    delivery.confirmed(retained)
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    sleeping = null
    delivery.refresh(mailbox)
    sleeping = record
    delivery.request(mailbox)
    await settled()
    expect(wake).toHaveBeenCalledTimes(1)
    db.markAsRead([message.id])
    delivery.refresh(mailbox)
    expect(delivery.failedToWake(retained)).toBe(false)
    expect(delivery.heldWorktrees()).toEqual([])

    for (let i = 0; i < 20; i++) {
      sleeping = record
      wake.mockResolvedValueOnce(i % 2 === 0)
      const nextRun = db.createRun({
        objective: 'retention',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: paneKey
      })
      const handle = `run:${nextRun.id}`
      const row = db.insertMessage({
        runId: nextRun.id,
        from: 'worker',
        to: handle,
        subject: 'done'
      })
      delivery.request(handle)
      await settled()
      db.markAsRead([row.id])
      delivery.refresh(handle)
    }
    expect(wake).toHaveBeenCalledTimes(21)
    expect(delivery.failedToWake(record)).toBe(false)
    expect(delivery.heldWorktrees()).toEqual([])
  } finally {
    db.close()
  }
})

it('holds a launched wake across a restart but wakes again for a claim that never launched', async () => {
  for (const launched of [true, false]) {
    const db = new OrchestrationDb(':memory:')
    const slept = { ...record, worktreeId: 'repo::/workspace' }
    db.claimMailWake(slept, 'claim', 100)
    if (launched) {
      db.recordMailWakeLaunch(paneKey, 'claim', {
        ptyId: 'pty-old',
        incarnationId: 'incarnation',
        launchToken: 'token'
      })
    }
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [paneKey]: slept }
    }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: () => session,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: () => () => {}
      })
    )
    const resume = vi.fn(
      async (_workspace: string, _pane?: string, prepare?: boolean) => prepare === true
    )
    try {
      const run = db.createRun({
        objective: 'restart',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: paneKey
      })
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'done' })
      runtime.setOrchestrationDb(db)
      runtime.setNotifier(mailNotifier(resume))
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      runtime.retrySleptMailboxWakes()
      await settled()
      await settled()
      expect(resume.mock.calls.filter((call) => call[2] !== true)).toEqual(
        launched ? [] : [['repo::/workspace', paneKey]]
      )
      // The refused relaunch leaves no claim behind, so a later edge can try again.
      expect(db.listMailWakeAttempts().map((attempt) => attempt.mailWake?.id)).toEqual(
        launched ? ['claim'] : []
      )
    } finally {
      runtime.setNotifier(null)
      db.close()
    }
  }
})

it('clears the original workspace hold and custody when another terminal replies to its last mail', async () => {
  const db = new OrchestrationDb(':memory:')
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: { ...record, origin: 'quit', restoreOnTabOpenOnly: true }
    }
  }
  db.claimMailWake(record, 'reply-custody', 100)
  db.recordMailWakeLaunch(paneKey, 'reply-custody', {
    ptyId: 'pty-old',
    incarnationId: 'incarnation',
    launchToken: 'token'
  })
  let written: (host: ExecutionHostId | null) => void = () => {}
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getFolderWorkspace: () =>
        storeFolderWorkspace({
          id: 'workspace',
          projectGroupId: 'group',
          folderPath: '/workspace',
          executionHostId: 'local'
        }),
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      setWorkspaceSession: (next) => {
        session = next
        written('local')
      },
      runDurableMutation: async (mutation) => mutation().value,
      onWorkspaceSessionWritten: (listener) => {
        written = listener
        return () => {}
      }
    })
  )
  const bell = vi.fn()
  runtime.setNotifier(
    mailNotifier(
      vi.fn(async () => false),
      bell
    )
  )
  try {
    const run = db.createRun({
      objective: 'reply consumes mail',
      coordinatorHandle: 'term_asleep',
      coordinatorPaneKey: paneKey
    })
    const mailbox = `run:${run.id}`
    const sender = db.createRun({
      objective: 'sender',
      coordinatorHandle: 'term_sender',
      coordinatorPaneKey: null
    })
    const original = db.insertMessage({
      runId: run.id,
      from: `run:${sender.id}`,
      to: mailbox,
      subject: 'question'
    })
    runtime.setOrchestrationDb(db)
    runtime.retrySleptMailboxWakes()
    await settled()
    expect(await runtime.readSleepingMailHold(mailbox)).toMatchObject({
      kind: 'asleep',
      resuming: false
    })
    expect(bell).toHaveBeenLastCalledWith(['folder:workspace'])
    db.db.exec('BEGIN IMMEDIATE')
    db.markAsRead([original.id])
    db.db.exec('ROLLBACK')
    await settled()
    expect(await runtime.readSleepingMailHold(mailbox)).not.toBeNull()
    await ORCHESTRATION_REPLY_METHOD.handler(
      ORCHESTRATION_REPLY_METHOD.params.parse({
        id: original.id,
        from: 'term_other',
        body: 'answer'
      }),
      { runtime }
    )
    await settled()
    expect(db.getMessageById(original.id)?.read).toBe(1)
    expect(await runtime.readSleepingMailHold(mailbox)).toBeNull()
    expect(db.listMailWakeAttempts()).toEqual([])
    expect(bell).toHaveBeenLastCalledWith([])
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})
