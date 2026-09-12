import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-projection'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performSend, type AgentSessionTurnContext } from './structured-agent-session-turns'

const journals = createTrackedJournalOpener()

let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-send-idempotency-'))
  journal = await journals.open({
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
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('structured send idempotency', () => {
  it('publishes a recovered retry as working before waiting for its provider', async () => {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'retry' }]
    }
    const input = { clientMessageId: 'retry-id', payloadFingerprint: 'fingerprint', body }
    await journal.appendSubmission({ ...input, fence: 1 })
    await journal.markPendingSubmissionsUnknown(2, 'provider_write_failed: broken pipe')
    const originalItem = journal.snapshot().items[0]
    const publish = vi.fn()
    const dispatch = vi.fn(async () => {
      expect(publish).toHaveBeenCalledOnce()
      expect(hasUnansweredStructuredAgentSessionDispatch(journal.submissions(), 2)).toBe(true)
      return { state: 'unknown' as const, reason: 'ack timeout' }
    })
    await performSend(
      {
        sessionId: 'session-1',
        journal,
        fence: 2,
        adapter: { dispatch } as unknown as StructuredAgentSessionAdapter,
        persistOptions: async () => undefined,
        persistOperationOutcome: async () => undefined,
        flushLifecycle: async () => undefined,
        resolvedBy: 'caller',
        publish,
        now: () => 1
      },
      { ...input, retryUnknown: true }
    )
    expect(hasUnansweredStructuredAgentSessionDispatch(journal.submissions(), 2)).toBe(true)
    expect(journal.snapshot().items).toEqual([originalItem])
  })

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
      persistOperationOutcome: async () => undefined,
      flushLifecycle: async () => undefined,
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
