import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { openAgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudePendingPrompt } from '../../claude-prompt-registry'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

// Claude Code 2.1.258 / SDK 0.3.251 capture: only message.id links partial and final frames.
function streamEvent(uuid: string, event: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      event
    }
  }
}

function resultFrame(subtype: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype,
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      session_id: 'claude-session',
      uuid: `result-${subtype}`,
      ...fields
    }
  }
}

function streamedTextTurn(input: {
  messageId: string
  startUuid: string
  finalUuid: string
  chunks: string[]
}) {
  const text = input.chunks.join('')
  return {
    start: [
      streamEvent(`${input.messageId}-message-start`, {
        type: 'message_start',
        message: { id: input.messageId, role: 'assistant', content: [] }
      }),
      streamEvent(input.startUuid, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    ],
    deltas: input.chunks.map((chunk, index) =>
      streamEvent(`${input.messageId}-delta-${index}`, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk }
      })
    ),
    final: {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: input.finalUuid,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: {
          id: input.messageId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null
        }
      }
    },
    stop: [
      streamEvent(`${input.messageId}-block-stop`, { type: 'content_block_stop', index: 0 }),
      streamEvent(`${input.messageId}-message-delta`, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' }
      }),
      streamEvent(`${input.messageId}-message-stop`, { type: 'message_stop' }),
      resultFrame('success', {
        is_error: false,
        result: text,
        stop_reason: 'end_turn',
        terminal_reason: 'completed'
      })
    ],
    text
  }
}

function assistantMessages<T extends { body: AgentJournalItemBody }>(items: T[]): T[] {
  return items.filter((item) => item.body.kind === 'message' && item.body.role === 'assistant')
}

function providerFrameKinds(items: { body: AgentJournalItemBody }[]): string[] {
  return items.flatMap((item) =>
    item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
  )
}

const JOURNAL_IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('claude-session', 'leaf-1')
}

let journalRoot = ''

beforeEach(async () => {
  journalRoot = await mkdtemp(join(tmpdir(), 'orca-claude-journal-translation-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(journalRoot, { recursive: true, force: true })
})

describe('Claude structured journal translation', () => {
  it('journals a count-to-200 stream as one assistant item carrying the complete reply', async () => {
    const journal = await openAgentSessionJournal({
      identity: JOURNAL_IDENTITY,
      database: openTestJournalHostDatabase(journalRoot),
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: vi.fn() })
    let scheduled: (() => void) | null = null
    const translator = createClaudeJournalTranslator({
      sink: deferred.sink,
      schedule: (run) => {
        scheduled = run
        return () => {
          scheduled = null
        }
      }
    })
    const numbers = Array.from({ length: 200 }, (_, index) => String(index + 1))
    // The chunk boundaries the real CLI produced for this prompt.
    const boundaries = [0, 1, 45, 93, 141, 189, 200]
    const chunks = boundaries.slice(1).map((end, index) => {
      const slice = numbers.slice(boundaries[index], end).join('\n')
      return index === 0 ? slice : `\n${slice}`
    })
    const turn = streamedTextTurn({
      messageId: 'msg_count',
      startUuid: 'count-start',
      finalUuid: 'count-final',
      chunks
    })

    for (const event of turn.start) {
      translator.handle(event)
    }
    for (const delta of turn.deltas) {
      translator.handle(delta)
      // Each chunk lands in its own coalescing window, as it did on the wire.
      const run = scheduled as (() => void) | null
      run?.()
    }
    translator.handle(turn.final)
    for (const event of turn.stop) {
      translator.handle(event)
    }
    await deferred.drained()

    const items: AgentJournalRenderItem[] = journal.snapshot().items
    const assistant = assistantMessages(items)
    expect(assistant.map((item) => item.itemId)).toEqual([
      'claude:claude-session:block%3Amsg_count%3A0'
    ])
    expect(assistant[0]?.body).toEqual({
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: numbers.join('\n') }]
    })
    expect(providerFrameKinds(items)).toEqual([])
  })

  it('restores a cancelled prompt as terminal history after reopening the journal', async () => {
    const journal = await openAgentSessionJournal({
      identity: JOURNAL_IDENTITY,
      database: openTestJournalHostDatabase(journalRoot),
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: vi.fn() })
    const translator = createClaudeJournalTranslator({ sink: deferred.sink })
    const approval = prompt({
      requestId: 'permission-1',
      promptKey: 'permission-1',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      kind: 'approval',
      input: { command: 'git status' },
      questionIds: []
    })

    translator.handle({ type: 'prompt', sessionId: 'orca-session', prompt: approval })
    translator.handle({
      type: 'prompt-cancelled',
      sessionId: 'orca-session',
      promptKey: approval.promptKey
    })
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    deferred.close()
    await journal.close()

    const reopened = await openAgentSessionJournal({
      identity: JOURNAL_IDENTITY,
      database: openTestJournalHostDatabase(journalRoot),
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-2'
    })
    expect(reopened.snapshot().items).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'cancelled' })
        })
      })
    ])
    await reopened.close()
  })
})

function prompt(
  input: Pick<
    ClaudePendingPrompt,
    'requestId' | 'promptKey' | 'toolUseId' | 'toolName' | 'kind' | 'input' | 'questionIds'
  >
): ClaudePendingPrompt {
  return {
    ...input,
    suggestions: [],
    settle: () => {}
  }
}
