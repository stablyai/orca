import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session-journal-item-key'
import {
  selectAgentSessionPrefix,
  structuredForkEligibleItems,
  structuredForkTurnAnchors
} from '../../shared/agent-session-prefix'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'

type Frame = Extract<ClaudeStructuredSessionEvent, { type: 'message' }>

/**
 * Provenance: every uuid below is copied verbatim from the `.jsonl` Claude wrote during the
 * rendered-Electron QA run that pinned this defect, and the frames are wired the way that run's
 * transcript records them:
 *
 *   line 25  user       77ec22c2  "Now reply with exactly the word BRAVO…"
 *   line 26  assistant  67313d90  msg_011Ceu7HLQoPYZCDp8LZVX56  text "BRAVO"
 *   line 38  user       7e76b294  "Write a detailed 600-word essay…"
 *   line 39  assistant  6c888cea  msg_011Ceu91wetn6Ai8ckE4YGUf  thinking
 *   line 40  assistant  8b0ed04b  msg_011Ceu91wetn6Ai8ckE4YGUf  text
 *
 * Two shapes matter and neither is guessable: the transcript writes ONE ROW PER CONTENT BLOCK, so
 * a thinking block and a text block of one assistant message land as two rows with two different
 * uuids sharing one `message.id`; and no `stream_event` uuid is ever written to the file. The
 * stream uuid used below is the one the failing run actually sent as `resumeSessionAt`, which
 * Claude rejected with "No message found with message.uuid of: 0e99dedf-…".
 */
const TRANSCRIPT = {
  bravoPrompt: '77ec22c2-f5ae-4f63-93fc-6af53bfc0b04',
  bravoAnswer: '67313d90-6937-4514-a63f-582b1df9d5d0',
  essayPrompt: '7e76b294-88ca-4182-9358-bc661e29589b',
  essayThinking: '6c888cea-39ff-4cd2-98b6-0e846ea83f38',
  essayAnswer: '8b0ed04b-ff8b-49fa-8266-5b60138e4230'
} as const

/** Exactly the uuids the file carries. A `stream_event` uuid is absent by construction. */
const TRANSCRIPT_UUIDS: ReadonlySet<string> = new Set(Object.values(TRANSCRIPT))

const SESSION = 'claude-session'
const HANDLE: AgentSessionProviderHandle = {
  provider: 'claude',
  sessionId: SESSION,
  leafUuid: TRANSCRIPT.essayAnswer
}

function userFrame(uuid: string, text: string): Frame {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    startsTurn: true as const,
    message: {
      type: 'user',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] }
    }
  }
}

function streamEvent(uuid: string, event: Record<string, unknown>): Frame {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: null,
      event
    }
  }
}

function assistantFrame(uuid: string, messageId: string, content: unknown[]): Frame {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'assistant',
      uuid,
      session_id: SESSION,
      parent_tool_use_id: null,
      message: { id: messageId, role: 'assistant', content, stop_reason: null }
    }
  }
}

function resultFrame(): Frame {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      session_id: SESSION,
      uuid: `result-${Math.random()}`
    }
  }
}

/** A streamed assistant text block: its own stream uuid, then the final frame's transcript uuid. */
function streamedText(input: {
  messageId: string
  streamUuid: string
  finalUuid: string
  text: string
}): Frame[] {
  return [
    streamEvent(`${input.messageId}-message-start`, {
      type: 'message_start',
      message: { id: input.messageId, role: 'assistant', content: [] }
    }),
    streamEvent(input.streamUuid, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }),
    streamEvent(`${input.messageId}-delta`, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: input.text }
    }),
    assistantFrame(input.finalUuid, input.messageId, [{ type: 'text', text: input.text }])
  ]
}

/** The user's own bubble is NOT the provider echo: `claudeOutputEnvelope` strips a user frame to
 *  its tool results, so the row is the optimistic submission, reconciled to the prompt's real uuid
 *  through `providerItemId`. Modelling it any other way would test a journal the host never builds. */
type Prompt = { kind: 'prompt'; clientMessageId: string; promptUuid: string; text: string }
type Step = Prompt | { kind: 'frame'; frame: Frame }

function prompt(clientMessageId: string, promptUuid: string, text: string): Prompt {
  return { kind: 'prompt', clientMessageId, promptUuid, text }
}

const frame = (value: Frame): Step => ({ kind: 'frame', frame: value })

/** Folds the sink the way the journal reducer does: an append upserts under the identity's key
 *  keeping its original position, a tombstone removes that row. Order is event order. */
function journalFrom(steps: readonly Step[]): {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSnapshot['submissions']
} {
  const rows = new Map<string, AgentJournalItemBody>()
  const submissions: AgentJournalSnapshot['submissions'] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      rows.set(agentJournalItemKey(identity), body)
    },
    appendTombstone: (identity: AgentJournalItemIdentity) => {
      rows.delete(agentJournalItemKey(identity))
    },
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'anchor-test' })
  for (const step of steps) {
    if (step.kind === 'prompt') {
      rows.set(agentJournalSubmissionKey(step.clientMessageId), {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: step.text }]
      })
      submissions.push({
        clientMessageId: step.clientMessageId,
        fence: 1,
        payloadFingerprint: `fingerprint-${step.clientMessageId}`,
        dispatchState: 'accepted',
        providerItemId: agentJournalItemKey({
          provider: 'claude',
          sessionId: SESSION,
          uuid: step.promptUuid
        }),
        reason: null,
        submittedAt: submissions.length,
        resolvedAt: submissions.length
      })
      continue
    }
    translator.handle(step.frame)
  }
  translator.flush()
  translator.dispose()
  const items = [...rows.entries()].map(([itemId, body], index): AgentJournalRenderItem => ({
    itemId,
    revision: 1,
    body,
    sequence: index,
    observedAt: index
  }))
  return { items, submissions }
}

/** Both turns settled, streamed exactly as the CLI streams them. */
function settledJournal() {
  return journalFrom([
    prompt('cm-bravo', TRANSCRIPT.bravoPrompt, 'Reply with exactly the word BRAVO.'),
    frame(
      userFrame(TRANSCRIPT.bravoPrompt, 'Now reply with exactly the word BRAVO and nothing else.')
    ),
    ...streamedText({
      messageId: 'msg_011Ceu7HLQoPYZCDp8LZVX56',
      // The uuid the failing run sent as `resumeSessionAt`; it is not in the transcript.
      streamUuid: '0e99dedf-189e-4bfc-b305-04e6eb07ce17',
      finalUuid: TRANSCRIPT.bravoAnswer,
      text: 'BRAVO'
    }).map(frame),
    frame(resultFrame()),
    prompt('cm-essay', TRANSCRIPT.essayPrompt, 'Write a 600-word essay about the number zero.'),
    frame(
      userFrame(TRANSCRIPT.essayPrompt, 'Write a detailed 600-word essay about the number zero.')
    ),
    // One message, two transcript rows: the thinking block carries its own uuid.
    frame(
      assistantFrame(TRANSCRIPT.essayThinking, 'msg_011Ceu91wetn6Ai8ckE4YGUf', [
        { type: 'thinking', thinking: 'The user wants an essay.' }
      ])
    ),
    ...streamedText({
      messageId: 'msg_011Ceu91wetn6Ai8ckE4YGUf',
      streamUuid: 'ff2b7c41-6c5e-4f0a-9d3b-2f1c8e5a7b90',
      finalUuid: TRANSCRIPT.essayAnswer,
      text: '# The History of Zero'
    }).map(frame),
    frame(resultFrame())
  ])
}

describe('claude fork anchor against a real transcript', () => {
  it('anchors the forked turn on a uuid the transcript actually contains', () => {
    const { items, submissions } = settledJournal()
    const anchors = structuredForkTurnAnchors(items)
    const eligible = [...structuredForkEligibleItems(anchors)]
    // One fork affordance per settled turn: BRAVO and the essay.
    expect(eligible).toHaveLength(2)

    const selected = selectAgentSessionPrefix({
      items,
      submissions,
      itemId: eligible[0]!,
      handle: HANDLE,
      boundary: 'through'
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) {
      return
    }
    // The whole defect in one assertion: Claude answers `initialize` with "No message found with
    // message.uuid of: <x>" for any uuid its transcript does not carry.
    expect(TRANSCRIPT_UUIDS).toContain(selected.throughId)
    // …and it must be the END of the forked turn, so the child contains that turn's answer.
    expect(selected.throughId).toBe(TRANSCRIPT.bravoAnswer)
  })

  it('keeps the forked turn INCLUSIVE and stops before the following turn', () => {
    const { items, submissions } = settledJournal()
    const eligible = [...structuredForkEligibleItems(structuredForkTurnAnchors(items))]
    const selected = selectAgentSessionPrefix({
      items,
      submissions,
      itemId: eligible[0]!,
      handle: HANDLE,
      boundary: 'through'
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) {
      return
    }
    const retained = selected.retained.map((item) => item.itemId)
    expect(retained).toContain(`claude:${SESSION}:${TRANSCRIPT.bravoPrompt}`)
    expect(retained).toContain(`claude:${SESSION}:${TRANSCRIPT.bravoAnswer}`)
    // The next turn is the boundary, not part of the child.
    expect(retained).not.toContain(`claude:${SESSION}:${TRANSCRIPT.essayPrompt}`)
    expect(retained).not.toContain(`claude:${SESSION}:${TRANSCRIPT.essayAnswer}`)
  })

  it('leaves no phantom stream uuid addressable as a claude row', () => {
    for (const item of settledJournal().items) {
      const uuid = item.itemId.startsWith(`claude:${SESSION}:`)
        ? item.itemId.slice(`claude:${SESSION}:`.length)
        : null
      if (uuid !== null) {
        expect(TRANSCRIPT_UUIDS).toContain(uuid)
      }
    }
  })

  it('resolves the rewind anchor to a real transcript uuid too', () => {
    const { items, submissions } = settledJournal()
    const essayPrompt = items.find((item) => item.itemId === agentJournalSubmissionKey('cm-essay'))
    expect(essayPrompt).toBeDefined()
    const selected = selectAgentSessionPrefix({
      items,
      submissions,
      itemId: essayPrompt!.itemId,
      handle: HANDLE,
      boundary: 'before'
    })
    expect(selected.ok).toBe(true)
    if (!selected.ok) {
      return
    }
    // Rewind is EXCLUSIVE: it targets the row before the selected prompt, and proves that uuid
    // against the transcript — an unreal one refuses as `proof-mismatch`.
    expect(TRANSCRIPT_UUIDS).toContain(selected.claude?.targetUuid)
    expect(selected.claude?.targetUuid).toBe(TRANSCRIPT.bravoAnswer)
  })
})
