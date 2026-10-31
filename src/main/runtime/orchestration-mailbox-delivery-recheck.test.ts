import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  sqliteFor,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { MAILBOX_POINTER_RESERVED } from './orchestration/db/messages/mailbox-pointer-enter-state'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const POINTER = expect.stringContaining('You have 1 orchestration message')

function hookRow(agentType: 'codex' | 'claude', state: AgentStatusIpcPayload['state']) {
  return {
    paneKey: PANE_KEY,
    terminalHandle: TERMINAL_HANDLE,
    agentType,
    state,
    prompt: '',
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now()
  } satisfies AgentStatusIpcPayload
}

describe('mailbox delivery recheck arms only for delivery work', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('retries pending mail once the pane falls quiet', async () => {
    const db = createDatabase('orca-recheck-quiet-')
    const { runtime, write } = createRuntime(db)
    const run = createBoundRun(db, 'Quiet Run')
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    await runtime.listTerminals()

    // Name-only Codex is weak idle evidence until the output clock goes quiet.
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex\x07output\r\n', Date.now())
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)

    expect(write.mock.calls.map(([, data]) => data)).toEqual([POINTER, '\r'])
    db.close()
  })

  // A fresh done holds readiness for the final frame after output went quiet; no edge follows its deadline.
  it.each(['reserved before a restart', 'new'] as const)(
    'delivers %s mail once after a post-quiet final-frame hold',
    async (kind) => {
      const db = createDatabase('orca-recheck-final-frame-')
      let rows: AgentStatusIpcPayload[] = []
      const { runtime, write } = createRuntime(db, { getAgentStatusSnapshot: () => rows })
      const run = createBoundRun(db, 'Final frame Run')
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, '\x1b]0;⠋ Codex\x07• Proposed Plan\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(4000)

      const message = insertDirectRunMessage(db, run.id, 'Worker done')
      if (kind !== 'new') {
        sqliteFor(db)
          .prepare(
            'UPDATE messages SET pointer_enter_pending = ?, pointer_pty_id = ?, pointer_process_incarnation = ? WHERE id = ?'
          )
          .run(MAILBOX_POINTER_RESERVED, PTY_ID, `${PTY_ID}:mailbox-incarnation`, message.id)
      }
      rows = [hookRow('codex', 'done')]
      runtime['deliverPendingMessagesForPty'](PTY_ID)
      expect(write).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(write.mock.calls.map(([, data]) => data)).toEqual([POINTER, '\r'])
      expect(runtime['deliveryRecheckTimersByPtyId'].size).toBe(0)
      db.close()
    }
  )

  // Recognition finishing only publishes a snapshot, so pending mail needs a retry past the quiet window.
  it('delivers once foreground recognition resolves after the quiet retry', async () => {
    const db = createDatabase('orca-recheck-recognition-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    let recognize: (process: string) => void = () => {}
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: () => new Promise<string>((resolve) => (recognize = resolve))
    })
    const run = createBoundRun(db, 'Recognition Run')
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]0;⠋ Codex\x07working\r\n', Date.now())
    await vi.advanceTimersByTimeAsync(5000)
    expect(write).not.toHaveBeenCalled()

    recognize('codex')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(write.mock.calls.map(([, data]) => data)).toEqual([POINTER, '\r'])
    expect(runtime['deliveryRecheckTimersByPtyId'].size).toBe(0)
    db.close()
  })

  it('arms no retry for an empty mailbox without an output clock', async () => {
    const db = createDatabase('orca-recheck-no-clock-')
    const { runtime } = createRuntime(db)
    createBoundRun(db, 'Empty Run')
    await runtime.listTerminals()
    expect(runtime['readOutputClockAt'](PTY_ID)).toBeNull()

    expect(runtime['checkDeliverySettledAndArmRecheck'](PTY_ID)).toBe(false)
    expect(runtime['deliveryRecheckTimersByPtyId'].size).toBe(0)
    db.close()
  })

  it('arms no retry for an empty mailbox behind a draft hold', async () => {
    const db = createDatabase('orca-recheck-hold-')
    const { runtime } = createRuntime(db, {
      getAgentStatusSnapshot: () => [hookRow('claude', 'done')],
      checkHookAgentPresence: async () => 'live',
      launchAgent: 'claude'
    })
    createBoundRun(db, 'Empty Run')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${'─'.repeat(40)}\r\n❯ `, 1)
    runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'please refactor the auth')
    runtime.onPtyData(PTY_ID, 'please refactor the auth', 2)
    await vi.advanceTimersByTimeAsync(200)
    expect(runtime['isPtyHoldingDelivery'](PTY_ID)).toBe(true)

    expect(runtime['checkDeliverySettledAndArmRecheck'](PTY_ID)).toBe(false)
    expect(runtime['deliveryRecheckTimersByPtyId'].size).toBe(0)
    db.close()
  })
})
