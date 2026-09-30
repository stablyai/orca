import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionConversationCommandRecord } from '../../../shared/agent-session-conversation-command'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  openConversationForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'

function withCommand(command: AgentSessionConversationCommandRecord) {
  return { ...agentSessionRecordFixture(), conversationCommand: command }
}

const COMMAND = { operationId: 'operation-1', callerKey: 'client-1', runtimeFence: 7 }

describe('a send refused by the conversation command it follows', () => {
  // A clear's commit is its only durable write, so a record short of it never changed the chat.
  it("lets a send follow a /clear that never committed, as an older build's record leaves one", () => {
    expect(
      structuredAgentSessionSendBlock(
        withCommand({
          ...COMMAND,
          command: 'clear',
          state: 'unknown',
          phase: 'prepared',
          replacementSessionId: 'clear-replacement-1'
        })
      )
    ).toBeNull()
  })

  it('says a committed /clear cleared the conversation', () => {
    const blocked = structuredAgentSessionSendBlock(
      withCommand({
        ...COMMAND,
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        replacementSessionId: 'clear-replacement-1'
      })
    )

    expect(blocked?.refusal).toMatchObject({
      code: 'agent_session_operation_invalid',
      details: { reason: 'conversationCleared' }
    })
  })

  it("lets a send follow an older build's unconfirmed /compact, whose child this host no longer runs", () => {
    expect(
      structuredAgentSessionSendBlock(
        withCommand({ ...COMMAND, command: 'compact', state: 'unknown', phase: 'prepared' })
      )
    ).toBeNull()
  })

  it('lets a send follow a /clear whose new conversation failed to start', () => {
    expect(
      structuredAgentSessionSendBlock(
        withCommand({ ...COMMAND, command: 'clear', state: 'completed', phase: 'committed' })
      )
    ).toBeNull()
  })
})

describe('a write whose conversation the host could not open', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const ENVELOPE = {
    sessionId: 'session-1',
    clientOperationId: 'operation-1',
    expectedRuntimeFence: 1,
    payloadFingerprint: ''
  }

  function refusedBy(error: unknown) {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    return openConversationForWrite(async () => {
      throw error
    }, ENVELOPE)
  }

  it('says a corrupt history is final, in words and not the error', async () => {
    const corrupt = Object.assign(new Error('/Users/me/journal.db: file is not a database'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 26
    })

    expect(await refusedBy(corrupt)).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalCorrupt' },
        message: 'Unable to load this chat.'
      }
    })
  })

  it('says any other failed open can clear', async () => {
    const denied = Object.assign(new Error('EACCES: permission denied, open /Users/me'), {
      code: 'EACCES',
      errno: -13
    })

    expect(await refusedBy(denied)).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' },
        message: "Orca couldn't open this chat's history right now. Try again."
      }
    })
  })
})
