import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  TEST_WORKTREE_ID,
  setInMemoryOrchestrationMessages,
  store
} from './orca-runtime-test-fixtures.spec'

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

type RuntimeInternals = {
  issuePtyHandle: (pty: { ptyId: string }) => string
  ptysById: Map<string, { ptyId: string }>
}

async function createIdleBackgroundAgent(opts?: { ptyId?: string }) {
  const runtime = new OrcaRuntimeService(store)
  const db = new InMemoryOrchestrationMessages()
  const write = vi.fn().mockReturnValue(true)
  const ptyId = opts?.ptyId ?? 'pty-bg'
  setInMemoryOrchestrationMessages(runtime, db)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => null
  })
  const handle = runtime.preAllocateHandleForPty(ptyId)
  runtime.registerPty(ptyId, TEST_WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    terminalHandle: handle
  })
  const internals = runtime as unknown as RuntimeInternals
  internals.issuePtyHandle(internals.ptysById.get(ptyId)!)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  db.setRun({
    id: 'run_test',
    coordinator_handle: handle,
    coordinator_pane_key: PANE_KEY
  })
  return { runtime, db, write, ptyId, handle, mailbox: 'run:run_test' as const }
}

describe('background PTY orchestration mailbox delivery', () => {
  it('delivers pending orchestration messages to an already-idle background PTY', async () => {
    const { runtime, db, write, ptyId, handle, mailbox } = await createIdleBackgroundAgent()
    vi.useFakeTimers()
    try {
      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
      db.insertMessage({ from: 'term_sender', to: handle, subject: 'review please' })

      runtime.deliverPendingMessagesForHandle(handle)

      expect(write).toHaveBeenCalledWith(
        ptyId,
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      expect(write).toHaveBeenCalledWith(ptyId, '\r')

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers queued orchestration messages when a background PTY becomes idle', async () => {
    const { runtime, db, write, ptyId, handle, mailbox } = await createIdleBackgroundAgent()
    vi.useFakeTimers()
    try {
      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      db.insertMessage({ from: 'term_sender', to: handle, subject: 'queued review' })

      runtime.deliverPendingMessagesForHandle(handle)
      expect(write).not.toHaveBeenCalled()

      runtime.onPtyData(ptyId, '\x1b]0;Codex done\x07', 101)
      await vi.advanceTimersByTimeAsync(500)

      expect(write).toHaveBeenCalledWith(
        ptyId,
        expect.stringContaining('You have 1 orchestration message')
      )
      expect(write).toHaveBeenCalledWith(ptyId, '\r')
      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('injects background PTY orchestration messages for Cursor Agent without auto-submitting', async () => {
    const { runtime, db, write, ptyId, handle, mailbox } = await createIdleBackgroundAgent()
    vi.useFakeTimers()
    try {
      runtime.onPtyData(ptyId, '\x1b]0;\u280b Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, '\x1b]0;Cursor ready\x07', 101)
      db.insertMessage({ from: 'term_sender', to: handle, subject: 'hello cursor bg' })

      runtime.deliverPendingMessagesForHandle(handle)

      expect(write).toHaveBeenCalledWith(
        ptyId,
        expect.stringContaining('You have 1 orchestration message')
      )
      await vi.advanceTimersByTimeAsync(500)
      const submitWrites = write.mock.calls.filter(([id, text]) => id === ptyId && text === '\r')
      expect(submitWrites).toHaveLength(0)

      const unread = db.getUnreadMessages(mailbox)
      expect(unread).toHaveLength(1)
      expect(unread[0].read).toBe(0)
      expect(unread[0].delivered_at).not.toBeNull()
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
