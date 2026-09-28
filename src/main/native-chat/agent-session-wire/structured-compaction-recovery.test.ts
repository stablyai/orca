import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { settleInterruptedCompaction } from './structured-compaction-recovery'

describe('settleInterruptedCompaction', () => {
  it("records the unconfirmed compaction in its fact's own words, on the row and the command", async () => {
    const command = {
      command: 'compact' as const,
      state: 'unknown' as const,
      phase: 'prepared' as const,
      operationId: 'op-1',
      callerKey: 'client-1',
      runtimeFence: 1
    }
    const setConversationCommand = vi.fn(async () => undefined)
    const store = {
      getRecord: () => ({ conversationCommand: command }),
      setConversationCommand,
      recordOperationOutcome: vi.fn(async () => undefined)
    }
    const appendItem = vi.fn(async () => ({ cursor: { epoch: 'e', sequence: 1 } }))

    await settleInterruptedCompaction(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function reads only the members stubbed above.
      store as unknown as AgentSessionRecordStore,
      'session-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function calls only `appendItem`.
      { appendItem } as unknown as AgentSessionJournal,
      2
    )

    const words = {
      text: 'Compaction completion is unconfirmed.',
      failure: { kind: 'compactionUnconfirmed' }
    }
    expect(appendItem).toHaveBeenCalledWith(
      { provider: 'orca', clientMessageId: 'compact:op-1' },
      { kind: 'status', ...words },
      { fence: 2 }
    )
    expect(setConversationCommand).toHaveBeenCalledWith(
      'session-1',
      2,
      expect.objectContaining({ error: words.text, failure: words.failure, state: 'unknown' })
    )
  })
})
