import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  WORKTREE_ID,
  TERMINAL_HANDLE,
  PANE_KEY,
  LAUNCH_TOKEN,
  sqliteFor,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { countForegroundSqlWork } from './mailbox-foreground-work.test-fixture'
import { NOTIFICATION_METHODS } from '../../../rpc/methods/notifications/notifications'
import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrcaRuntimeService } from '../../../orca-runtime'

async function checkRun(runtime: OrcaRuntimeService, run: string) {
  const response = await new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS }).dispatch({
    id: 'uncertain-mail-check',
    authToken: 'synthetic-token',
    method: 'orchestration.check',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationCompatibilityEvidence: {
      terminalHandle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      launchToken: LAUNCH_TOKEN
    },
    params: { terminal: TERMINAL_HANDLE, run }
  })
  expect(response).toMatchObject({ ok: true })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return z.object({ messages: z.array(z.object({ id: z.string() })) }).parse(response.result)
}

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

async function reconnect(runtime: OrcaRuntimeService) {
  const subscribe = NOTIFICATION_METHODS.find((method) => method.name === 'notifications.subscribe')
  if (!subscribe) {
    throw new Error('Missing notification subscription')
  }
  const received: { type: string; source?: string; subscriptionId?: string }[] = []
  const pending = subscribe.handler(undefined, { runtime }, (event) =>
    received.push(
      z
        .object({
          type: z.string(),
          source: z.string().optional(),
          subscriptionId: z.string().optional()
        })
        .parse(event)
    )
  )
  const id = received.find((event) => event.type === 'ready')?.subscriptionId
  expect(id).toEqual(expect.any(String))
  runtime.cleanupSubscription(id!)
  await pending
  return received.filter((event) => event.source === 'orchestration-uncertainty')
}

function inspectedForeground(process: string) {
  return {
    foregroundProcess: process,
    hasChildProcesses: process !== 'zsh',
    foregroundObservation: {
      ptyId: PTY_ID,
      ptyIncarnationId: 'mailbox-incarnation',
      authorityGeneration: 'test',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: process === 'zsh' ? ('shell' as const) : ('non-shell' as const),
      processName: process
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([2, 20])(
  'restores %i uncertain Run mailboxes as attention with zero recurring work',
  async (n) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-uncertain-mail-')
    const runs = Array.from({ length: n }, (_, i) => createBoundRun(db, `Unread Run ${i}`))
    const rows = runs.map((run, i) => {
      const row = insertDirectRunMessage(db, run.id, `Uncertain ${i}`)
      sqliteFor(db)
        .prepare(`UPDATE messages SET to_handle = ?, pointer_enter_pending = ?,
      pointer_pty_id = ?, pointer_process_incarnation = ? WHERE id = ?`)
        .run(
          `run:${run.id}`,
          i % 2 === 0 ? 2 : 3,
          PTY_ID,
          'pty-mailbox:mailbox-incarnation',
          row.id
        )
      return row
    })
    const { runtime, write } = createRuntime(db)
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const noticeDirectory = mkdtempSync(join(tmpdir(), 'orca-uncertain-attention-'))
    temporaryDirectories.push(noticeDirectory)
    runtime.configureNotificationDismissalStore(noticeDirectory)
    let process = 'zsh'
    const inspection = vi.fn(async () => inspectedForeground(process))
    runtime.setPtyController({
      write,
      writeWithSettlement: () => ({ outcome: 'accepted' }),
      kill: vi.fn(),
      getSize: () => ({ cols: 120, rows: 40 }),
      getForegroundProcess: async () => process,
      supportsForegroundObservation: () => true,
      inspectProcess: inspection
    })
    const notifications: {
      type: string
      source?: string
      body?: string
      notificationId?: string
    }[] = []
    runtime.onNotificationDispatched((event) => notifications.push(event))
    try {
      await runtime.listTerminals()
      const actionable = insertDirectRunMessage(db, runs[0].id, 'Establish recovery before restore')
      expect(await runtime.readTerminalMailHold(`run:${runs[0].id}`)).toMatchObject({
        kind: 'not-foreground'
      })
      db.markAsReadAndDelivered([actionable.id])
      await driveToLiveIdle(runtime)
      await vi.advanceTimersByTimeAsync(65000)
      const notices = notifications.filter((event) => event.source === 'orchestration-uncertainty')
      expect.soft(notices).toHaveLength(1)
      expect.soft(notices[0]?.body).toContain(`orca orchestration check --run ${runs[0].id}`)
      expect.soft(notices[0]?.body).toContain(`orca orchestration check --run ${runs[n - 1].id}`)
      expect.soft(notices[0]?.body).toContain('Codex')
      expect(write).not.toHaveBeenCalled()
      for (let i = 0; i < n; i++) {
        expect.soft(db.getMessageById(rows[i].id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: i % 2 === 0 ? 2 : 3
        })
      }
      const work = countForegroundSqlWork(db)
      const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
      work.clear()
      inspection.mockClear()
      await vi.advanceTimersByTimeAsync(600000)
      expect.soft(inspection).not.toHaveBeenCalled()
      expect.soft(attempts).not.toHaveBeenCalled()
      expect.soft(work.counts).toEqual({ statements: 0, owners: 0, messages: 0 })
      work.stop()
      for (const status of ['working', 'permission', 'idle']) {
        runtime.onPtyData(
          PTY_ID,
          `\x1b]0;Codex ${status === 'idle' ? 'done' : status}\x07`,
          Date.now()
        )
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(
        notifications.filter((event) => event.source === 'orchestration-uncertainty')
      ).toHaveLength(1)
      expect(db.getMessageById(rows[0].id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 2
      })
      for (let i = 0; i < 300; i++) {
        runtime.dispatchMobileNotification({ type: 'dismiss', notificationId: `filler-${i}` })
      }
      if (notices[0]?.notificationId) {
        runtime.dismissMobileNotification(notices[0].notificationId)
      }
      runtime.retireNotificationAttention({
        reads: [],
        worktree: {
          workspaceId: WORKTREE_ID,
          executionHostId: 'local',
          wslDistro: null,
          workspaceKind: 'git-worktree'
        }
      })
      expect(await reconnect(runtime)).toHaveLength(1)
      const missed = runtime.getMissedNotificationsSince(100000, 'offline-client-epoch')
      expect(
        missed.filter(
          (event) => event.type === 'notification' && event.source === 'orchestration-uncertainty'
        )
      ).toHaveLength(1)
      process = 'codex'
      runtime.onPtyData(
        PTY_ID,
        `\x1b[2J\x1b[H${readRuntimeFixture('codex-0157-plain-ready')}`,
        Date.now()
      )
      runtime.setPtyController({
        write,
        kill: vi.fn(),
        getSize: () => ({ cols: 120, rows: 40 }),
        getForegroundProcess: async () => process,
        supportsForegroundObservation: () => true,
        inspectProcess: inspection,
        writeWithSettlement: (ptyId, text) => {
          write(ptyId, text)
          if (text !== '\r') {
            runtime.onPtyData(PTY_ID, `\x1b[37;3H\x1b[0m\x1b[K${text.trim()}\x1b[37;3H`, Date.now())
          }
          return { outcome: 'accepted' }
        }
      })
      const newMail = insertDirectRunMessage(db, runs[0].id, 'New eligible mail')
      runtime.notifyMessageArrived(`run:${runs[0].id}`, 'status')
      await vi.advanceTimersByTimeAsync(10000)
      expect(write.mock.calls.map(([, text]) => text)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(newMail.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      const checked = await checkRun(runtime, runs[0].id)
      expect(checked.messages).toEqual([
        expect.objectContaining({ id: rows[0].id }),
        expect.objectContaining({ id: newMail.id })
      ])
      expect(db.getMessageById(rows[1].id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 3
      })
      for (const run of runs.slice(1)) {
        await checkRun(runtime, run.id)
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(
        runtime
          .getMissedNotificationsSince(100000, 'offline-client-epoch')
          .filter(
            (event) => event.type === 'notification' && event.source === 'orchestration-uncertainty'
          )
      ).toEqual([])
      expect(
        notifications.some(
          (event) => event.type === 'dismiss' && event.notificationId === notices[0].notificationId
        )
      ).toBe(true)
      expect(await reconnect(runtime)).toEqual([])
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.closeNotificationDismissals()
      db.close()
    }
  }
)

it.each(['missing pointer', 'unverifiable Enter'])(
  'retires %s immediately, announces unread mail and admits later mail without replay',
  async (loss) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-uncertain-transition-')
    const { runtime, write } = createRuntime(db, { launchAgent: 'claude' })
    const ready = `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-empty')}`
    let foreground = 'zsh'
    let lose = true
    let pointer = ''
    const inspect = vi.fn(async () => inspectedForeground(foreground))
    runtime.setPtyController({
      write,
      kill: vi.fn(),
      getSize: () => ({ cols: 100, rows: 30 }),
      getForegroundProcess: async () => foreground,
      supportsForegroundObservation: () => true,
      inspectProcess: inspect,
      writeWithSettlement: (ptyId, text) => {
        write(ptyId, text)
        if (text !== '\r') {
          pointer = text
          const screen =
            lose && loss === 'missing pointer'
              ? ready
              : `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${text.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`
          runtime.onPtyData(PTY_ID, screen, Date.now())
        }
        return lose && loss === 'unverifiable Enter' && text === '\r'
          ? {
              outcome: 'unverifiable',
              reason: 'transport_settlement_lost',
              bytesHandedToTransport: true
            }
          : { outcome: 'accepted' }
      }
    })
    const events: { type: string; source?: string }[] = []
    runtime.onNotificationDispatched((event) => events.push(event))
    try {
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, ready, Date.now())
      const run = createBoundRun(db, 'Uncertain transition')
      const old = insertDirectRunMessage(db, run.id, 'Retained unread mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      foreground = 'claude'
      await vi.advanceTimersByTimeAsync(65000)
      expect(pointer).toContain('You have 1 orchestration message')
      expect(db.getMessageById(old.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: loss === 'missing pointer' ? 2 : 3
      })
      expect
        .soft(events.filter((event) => event.source === 'orchestration-uncertainty'))
        .toHaveLength(1)
      const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
      const work = countForegroundSqlWork(db)
      inspect.mockClear()
      await vi.advanceTimersByTimeAsync(600000)
      expect.soft(attempts).not.toHaveBeenCalled()
      expect(inspect).not.toHaveBeenCalled()
      expect.soft(work.counts).toEqual({ statements: 0, owners: 0, messages: 0 })
      work.stop()
      const firstPointer = pointer
      lose = false
      runtime.onPtyData(PTY_ID, ready, Date.now())
      const newer = insertDirectRunMessage(db, run.id, 'Later eligible mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10000)
      expect(write.mock.calls.filter(([, text]) => text !== '\r')).toHaveLength(2)
      expect(write.mock.calls.filter(([, text]) => text === '\r')).toHaveLength(
        loss === 'missing pointer' ? 1 : 2
      )
      expect(write.mock.calls[0][1]).toBe(firstPointer)
      expect(db.getMessageById(old.id)).toMatchObject({ read: 0, delivered_at: null })
      expect(db.getMessageById(newer.id)).toMatchObject({
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      if (loss === 'unverifiable Enter') {
        await runtime.onPtyExit(PTY_ID, 0, 'mailbox-incarnation', { providerExitObserved: true })
        expect(
          runtime
            .getMissedNotificationsSince(100000, 'offline-client-epoch')
            .filter(
              (event) =>
                event.type === 'notification' && event.source === 'orchestration-uncertainty'
            )
        ).toEqual([])
        expect(db.getMessageById(old.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 3
        })
        return
      }
      const checked = await checkRun(runtime, run.id)
      expect(checked.messages).toEqual([
        expect.objectContaining({ id: old.id }),
        expect.objectContaining({ id: newer.id })
      ])
      expect(db.getMessageById(old.id)).toMatchObject({ read: 1, pointer_enter_pending: 0 })
      await vi.advanceTimersByTimeAsync(65000)
      expect(write.mock.calls.filter(([, text]) => text !== '\r')).toHaveLength(2)
    } finally {
      db.close()
    }
  }
)
