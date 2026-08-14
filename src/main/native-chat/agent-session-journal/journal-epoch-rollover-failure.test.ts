import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { publishNewEpoch } from './journal-epoch-rollover'
import { openAgentSessionJournal } from './journal-store'

let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('journal epoch rollover failure boundary', () => {
  it('adopts the durable new epoch when old-log cleanup fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-epoch-rollover-failure-'))
    const rewriteLog = vi.fn(async () => {
      throw new Error('log cleanup failed')
    })

    const published = await publishNewEpoch({
      journalDir: root,
      sessionId: 'session-1',
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      epoch: 'epoch-2',
      reason: 'handle_forked',
      fence: 2,
      now: 1_000,
      rewriteLog
    })

    expect(rewriteLog).toHaveBeenCalledOnce()
    expect(published.row).toMatchObject({ epoch: 'epoch-2', seq: 1, fence: 2 })
    expect(published.state.epoch).toBe('epoch-2')
    expect(published.state.lastSequence).toBe(1)

    const reopened = await openAgentSessionJournal({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root,
      now: () => 1_001,
      mintEpoch: () => 'unexpected-epoch'
    })
    expect(reopened.cursor()).toEqual({ epoch: 'epoch-2', sequence: 1 })
    const appended = await reopened.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [] },
      { fence: 2 }
    )
    expect(appended.cursor.sequence).toBe(2)
  })
})
