import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { OrchestrationMailboxPointerDelivery } from '../terminal-pointer/mailbox-pointer-delivery'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import { ORCHESTRATION_REPLY_METHOD } from '../../../rpc/methods/orchestration/messaging/reply-method'
import { MailWakeInvocations } from './mail-wake-invocations'
import { admitsMailWakeRetry } from './mail-wake-retry-admission'
import {
  retainMailWakeAttempt,
  restoreUndispatchedMailWake
} from '../../../session-lifecycle/projection/retained-mail-wake-attempt'
import { RestoredPaneStarter } from '../../../terminal/recovery/restored-pane-start'
import type { HostProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { RuntimeTerminalCreate } from '../../../../../shared/runtime-terminal-create-contract'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { confirmsMailWake } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import { OrcaRuntimeService } from '../../../orca-runtime'
import {
  partialRuntimeStore,
  storeFolderWorkspace
} from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import type { RuntimeNotifier } from '../../../client/events/runtime-notifier-contract'
import { sendDeliveryHoldWarning } from '../../../rpc/methods/orchestration/messaging/send-delivery-hold'
import { expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
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
    let sleeping: SleepingAgentSessionRecord | null = record
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

it('retains a failed resume with a live shell, and restarts only a proven invocation in an untouched shell', async () => {
  vi.useFakeTimers()
  const invocations = new MailWakeInvocations()
  const stop = new AbortController()
  let session: WorkspaceSessionState & {
    sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  } = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: {
        ...record,
        origin: 'quit' as const,
        mailWake: { id: 'obligation', capturedAt: 1, startedAt: 100 }
      }
    }
  }
  const captured = session.sleepingAgentSessionsByPaneKey[paneKey]!
  try {
    await retainMailWakeAttempt(
      async (edit) => {
        const next = edit(session)
        if (next) {
          session = {
            ...next,
            sleepingAgentSessionsByPaneKey: next.sleepingAgentSessionsByPaneKey ?? {}
          }
        }
      },
      captured,
      'pty-shell',
      {
        handle: 'term_shell',
        worktreeId: 'folder:workspace',
        title: null,
        incarnationId: 'inc-shell',
        launchToken: 'invocation-1'
      } satisfies RuntimeTerminalCreate
    )
    const retained = session.sleepingAgentSessionsByPaneKey[paneKey]!
    expect(retained).toMatchObject({
      origin: 'quit',
      restoreOnTabOpenOnly: true,
      mailWake: { id: 'obligation' }
    })
    let bytes: (data: string) => void = () => {}
    invocations.watch(retained, {
      readRecentTerminalOutput: () => '',
      readLaunchedAgentForeground: async () => 'shell',
      subscribeToTerminalData: (_pty, listener) => {
        bytes = listener
        return () => {}
      }
    })
    const confirmed = invocations.wait(retained, stop.signal)
    let inspection: HostProcessInspection = {
      foregroundProcess: 'zsh',
      hasChildProcesses: false
    }
    let onInspect = () => {}
    let drivingInput: number | null = null
    let occupied = false
    let owned = true
    let shellForeground = true
    const start = vi.fn(async () => ({ id: 'replacement' }))
    const starter = new RestoredPaneStarter({
      boundPtyId: () => 'pty-shell',
      isLive: () => true,
      start,
      retryMailWake: () =>
        admitsMailWakeRetry(retained, {
          current: () => session.sleepingAgentSessionsByPaneKey[paneKey]!,
          owns: () => owned,
          commandEnded: () => invocations.ended(retained),
          occupied: () => occupied,
          drivingInputAt: () => drivingInput,
          inspect: async () => {
            onInspect()
            return inspection
          },
          shellInFront: async () => shellForeground
        })
    })
    const pane = {
      worktreeId: 'folder:workspace',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
    const trigger = {
      automatic: true,
      retryMailWake: { id: 'obligation', ptyId: 'pty-shell', incarnationId: 'inc-shell' }
    }
    const write = vi.fn()
    let wakeResult: ReturnType<RestoredPaneStarter['ensureStarted']> | undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: shell delivery reads only the target and admission hook before refusing input.
    const pointer = new OrchestrationMailboxPointerDelivery({
      deliveryTarget: {
        resolveTerminal: () => ({
          ptyId: 'pty-shell',
          lastAgentStatus: null,
          lastAgentStatusObservedLive: false
        })
      },
      wakeSleepingRecipient: () => {
        wakeResult = starter.ensureStarted(pane, trigger)
      },
      writePty: write
    } as never)
    const resumeFromMail = () => {
      wakeResult = undefined
      pointer.deliverForHandle('run:waiting')
      return wakeResult
    }
    expect(await resumeFromMail()).toBeNull()
    bytes('\x1b]133;C\x07failure\r\n\x1b]133;D;1\x07')
    await vi.advanceTimersByTimeAsync(10_000)
    // Legacy no-child booleans, background children, typing and changed ownership prove no safe retry.
    expect(await resumeFromMail()).toBeNull()
    inspection = {
      foregroundProcess: 'zsh',
      hasChildProcesses: true,
      childProcessEvidence: 'children'
    }
    expect(await resumeFromMail()).toBeNull()
    inspection = { ...inspection, hasChildProcesses: false, childProcessEvidence: 'no-children' }
    onInspect = () => {
      drivingInput = 101
    }
    expect(await resumeFromMail()).toBeNull()
    drivingInput = null
    onInspect = () => {
      occupied = true
    }
    expect(await resumeFromMail()).toBeNull()
    occupied = false
    onInspect = () => {
      owned = false
    }
    expect(await resumeFromMail()).toBeNull()
    owned = true
    onInspect = () => {
      session.sleepingAgentSessionsByPaneKey[paneKey] = { ...record, restoreOnTabOpenOnly: true }
    }
    expect(await resumeFromMail()).toBeNull()
    expect(start).not.toHaveBeenCalled()
    session.sleepingAgentSessionsByPaneKey[paneKey] = retained
    onInspect = () => {}
    shellForeground = false
    expect(await resumeFromMail()).toBeNull()
    shellForeground = true
    expect(await resumeFromMail()).toEqual({ id: 'replacement' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
    expect(session.sleepingAgentSessionsByPaneKey[paneKey]?.mailWake?.id).toBe('obligation')
    const row: AgentStatusIpcPayload = {
      paneKey,
      connectionId: null,
      agentType: 'codex',
      state: 'waiting',
      prompt: '',
      receivedAt: 200,
      stateStartedAt: 200,
      providerSession: { key: 'session_id', id: 'conversation' },
      launchToken: 'invocation-1',
      providerSessionOnly: true,
      observation: {
        origin: 'launch',
        kind: 'identity-only',
        authorityId: 'host',
        incarnation: 1,
        revision: 1,
        observedAt: 200
      }
    }
    expect(invocations.observe(retained, [row], 'pty-shell')).toBe(false)
    const live = {
      ...row,
      providerSessionOnly: false,
      observation: { ...row.observation!, origin: 'hook' as const, kind: 'transition' as const }
    }
    expect(
      invocations.observe(retained, [{ ...live, launchToken: 'old-invocation' }], 'pty-shell')
    ).toBe(false)
    expect(
      invocations.observe(
        retained,
        [{ ...live, providerSession: { key: 'session_id', id: 'different' } }],
        'pty-shell'
      )
    ).toBe(false)
    expect(invocations.observe(retained, [{ ...live, isReplay: true }], 'pty-shell')).toBe(false)
    expect(
      confirmsMailWake(
        { ...retained, origin: 'worktree-sleep', restoreOnTabOpenOnly: true },
        live,
        'pty-shell'
      )
    ).toBe(false)
    expect(invocations.observe(retained, [live], 'pty-shell')).toBe(true)
    expect(await confirmed).toBe(true)
  } finally {
    stop.abort()
    invocations.retain(new Set())
    vi.useRealTimers()
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
    const retained: SleepingAgentSessionRecord = {
      ...record,
      origin: 'quit',
      restoreOnTabOpenOnly: true,
      capturedAt: 200,
      mailWake: { id: 'obligation', capturedAt: 1, startedAt: 100 }
    }
    sleeping = retained
    delivery.confirmed({ ...retained, mailWake: { ...retained.mailWake!, capturedAt: 2 } })
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

it.each([10, 100])(
  'keeps status visits and addressed mail queries bounded with %i saved sleepers',
  async (count) => {
    const db = new OrchestrationDb(':memory:')
    let visits = 0
    let statusChanged: (key: string) => void = () => {}
    let sessionWritten: (host: ExecutionHostId | null) => void = () => {}
    const records: Record<string, SleepingAgentSessionRecord> = {}
    const mailboxes: string[] = []
    const isRecordProperty = (
      target: SleepingAgentSessionRecord,
      property: string | symbol
    ): property is keyof SleepingAgentSessionRecord =>
      typeof property === 'string' && Object.hasOwn(target, property)
    const countRecordVisits: ProxyHandler<SleepingAgentSessionRecord> = {
      get(target, property) {
        visits++
        return isRecordProperty(target, property) ? target[property] : undefined
      }
    }
    for (let i = 0; i < count; i++) {
      const key = `tab-${i}:11111111-1111-4111-8111-${String(i).padStart(12, '0')}`
      records[key] = new Proxy<SleepingAgentSessionRecord>(
        {
          ...record,
          paneKey: key,
          tabId: `tab-${i}`,
          origin: 'quit',
          restoreOnTabOpenOnly: true,
          mailWake: {
            id: `custody-${i}`,
            capturedAt: 1,
            startedAt: 100,
            attempt: {
              ptyId: `pty-${i}`,
              incarnationId: `inc-${i}`,
              launchToken: `token-${i}`,
              startedAt: 100
            }
          }
        },
        countRecordVisits
      )
      const run = db.createRun({
        objective: 'scale',
        coordinatorHandle: `term_${i}`,
        coordinatorPaneKey: key
      })
      const mailbox = `run:${run.id}`
      mailboxes.push(mailbox)
      for (let j = 0; j < 5; j++) {
        db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'done' })
      }
    }
    const task = db.createTask({ spec: 'local completion', runId: mailboxes[0]!.slice(4) })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_local_worker',
      'tab-0:11111111-1111-4111-8111-000000000000'
    )
    let session = { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: records }
    const readSession = vi.fn(() => session)
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getWorkspaceSession: readSession,
        getWorkspaceSessionHostIds: () => ['local'],
        onWorkspaceSessionWritten: (listener) => {
          sessionWritten = listener
          return () => {}
        }
      }),
      undefined,
      {
        subscribeAgentStatusRowChanges: (listener) => {
          statusChanged = listener
          return () => {}
        }
      }
    )
    try {
      runtime.setOrchestrationDb(db)
      runtime.retrySleptMailboxWakes()
      await settled()
      visits = 0
      readSession.mockClear()
      statusChanged('unrelated:11111111-1111-4111-8111-111111111111')
      expect(visits).toBe(0)
      statusChanged('tab-0:11111111-1111-4111-8111-000000000000')
      // A status event needs only this pane's attempt and PTY identity; no session inventory.
      expect(visits).toBeLessThanOrEqual(4)
      expect(readSession).not.toHaveBeenCalled()
      const inventory = vi.spyOn(db, 'getUndeliveredUnreadMailboxHandles')
      const fullRows = vi.spyOn(db, 'getUndeliveredUnreadMessages')
      const newest = vi.spyOn(db, 'getUndeliveredUnreadSequence')
      db.completeDispatch(dispatch.id)
      await settled()
      expect(inventory).not.toHaveBeenCalled()
      expect(fullRows).not.toHaveBeenCalled()
      expect(newest.mock.calls.filter(([mailbox]) => mailbox !== mailboxes[0])).toEqual([])
      // One Run: refresh (1), custody validation (2), queue/start admission (4).
      expect(newest.mock.calls.length).toBeLessThanOrEqual(7)
      expect(newest).toHaveBeenCalled()
      newest.mockClear()
      runtime.retrySleptMailboxWakes('tab-0:11111111-1111-4111-8111-000000000000')
      await settled()
      expect(inventory).not.toHaveBeenCalled()
      expect(newest.mock.calls.filter(([mailbox]) => mailbox !== mailboxes[0])).toEqual([])
      expect(newest.mock.calls.length).toBeLessThanOrEqual(7)
      session = {
        ...session,
        sleepingAgentSessionsByPaneKey: Object.fromEntries(
          Object.keys(records).map((key) => [
            key,
            new Proxy<SleepingAgentSessionRecord>({ ...record, paneKey: key }, countRecordVisits)
          ])
        )
      }
      sessionWritten('local')
      await settled()
      visits = 0
      readSession.mockClear()
      statusChanged('tab-0:11111111-1111-4111-8111-000000000000')
      expect(visits).toBe(0)
      expect(readSession).not.toHaveBeenCalled()
      session = { ...session, sleepingAgentSessionsByPaneKey: {} }
      sessionWritten('local')
      await settled()
      inventory.mockClear()
      newest.mockClear()
      db.completeDispatch(dispatch.id)
      await settled()
      expect(inventory).not.toHaveBeenCalled()
      expect(newest).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  }
)

it('holds unknown dispatch custody but retries a positively undispatched wake on the record availability edge', async () => {
  const db = new OrchestrationDb(':memory:')
  const retained: SleepingAgentSessionRecord = {
    ...record,
    worktreeId: 'repo::/workspace',
    origin: 'quit',
    restoreOnTabOpenOnly: true,
    mailWake: { id: 'not-dispatched', capturedAt: 1, startedAt: 100 }
  }
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: { [paneKey]: retained }
  }
  let written: (host: ExecutionHostId | null) => void = () => {}
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getWorkspaceSession: () => session,
      getWorkspaceSessionHostIds: () => ['local'],
      onWorkspaceSessionWritten: (listener) => {
        written = listener
        return () => {}
      }
    })
  )
  const resume = vi.fn(
    async (_workspace: string, _pane?: string, prepare?: boolean) => prepare === true
  )
  const notifier = mailNotifier(resume)
  try {
    const run = db.createRun({
      objective: 'refused launch',
      coordinatorHandle: 'term_old',
      coordinatorPaneKey: paneKey
    })
    const mailbox = `run:${run.id}`
    db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'done' })
    runtime.setOrchestrationDb(db)
    runtime.setNotifier(notifier)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await settled()
    expect(await runtime.readSleepingMailHold(mailbox)).toMatchObject({
      resuming: false,
      openTab: true,
      liveShell: false
    })
    runtime.retrySleptMailboxWakes()
    await settled()
    expect(resume.mock.calls.filter((call) => call[2] !== true)).toHaveLength(0)
    await restoreUndispatchedMailWake(async (edit) => {
      const next = edit(session)
      if (next) {
        session = next
        written('local')
      }
    }, retained)
    await settled()
    expect(resume.mock.calls.filter((call) => call[2] !== true)).toEqual([
      ['repo::/workspace', 'tab:11111111-1111-4111-8111-111111111111']
    ])
    expect(session.sleepingAgentSessionsByPaneKey?.[paneKey]?.mailWake).toBeUndefined()
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})

it('clears the original workspace hold and custody when another terminal replies to its last mail', async () => {
  const db = new OrchestrationDb(':memory:')
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: {
        ...record,
        origin: 'quit',
        restoreOnTabOpenOnly: true,
        mailWake: { id: 'reply-custody', capturedAt: 1, startedAt: 100 }
      }
    }
  }
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
    const inventory = vi.spyOn(db, 'getUndeliveredUnreadMailboxHandles')
    const originalInvalidation = vi.fn()
    const unwatch = db.crewChanges.subscribe((event) => {
      if (event.trafficAddresses?.has(mailbox)) {
        originalInvalidation(db.getMessageById(original.id)?.read)
      }
    })
    db.db.exec('BEGIN IMMEDIATE')
    db.markAsRead([original.id])
    expect(originalInvalidation).not.toHaveBeenCalled()
    db.db.exec('ROLLBACK')
    await settled()
    expect(originalInvalidation).not.toHaveBeenCalled()
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
    unwatch()
    expect(originalInvalidation).toHaveBeenCalledWith(1)
    expect(db.getMessageById(original.id)?.read).toBe(1)
    expect(await runtime.readSleepingMailHold(mailbox)).toBeNull()
    expect(session.sleepingAgentSessionsByPaneKey?.[paneKey]?.mailWake).toBeUndefined()
    expect(inventory).not.toHaveBeenCalled()
    expect(bell).toHaveBeenLastCalledWith([], ['reply-custody'])
  } finally {
    runtime.setNotifier(null)
    db.close()
  }
})
