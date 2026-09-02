import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performSend, type AgentSessionTurnContext } from './structured-agent-session-turns'

let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-idempotency-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    },
    journalDir: root
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('structured send idempotency', () => {
  it('does not redispatch one send id reused across caller ledgers', async () => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'one durable send' }]
    }
    const dispatch = vi.fn(async () => ({
      state: 'accepted' as const,
      providerIdentity: {
        provider: 'codex' as const,
        threadId: 'thread-1',
        turnId: 'turn-1',
        ordinal: 0
      }
    }))
    const context: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { dispatch } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'caller',
      publish: vi.fn(),
      now: () => 1
    }
    const input = {
      clientMessageId: 'shared-send-id',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body }
      }),
      body
    }

    await performSend(context, input)
    const replay = await performSend(context, input)

    expect(replay).toMatchObject({
      ok: true,
      value: { clientMessageId: 'shared-send-id', submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(journal.submissions()).toHaveLength(1)
  })
})
