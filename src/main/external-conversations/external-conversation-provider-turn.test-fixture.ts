import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import { hostTestState } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'

const TURN = {
  provider: 'codex' as const,
  threadId: HOST_TEST_THREAD,
  turnId: 'turn-1',
  ordinal: 1
}

/** The provider runs the turn to its end and says something. `opener` is the message that started
 *  it, and `steer` one sent into it while it ran. */
export async function finishTurn(
  text: string,
  input: {
    opener?: AgentMessageSource | 'person'
    steer?: AgentMessageSource
    turnId?: string
    /** As Claude: the provider echoes the sent message, and the turn names the echo's id, which
     *  the journal keeps only as an alias of the send's row. */
    claudeEcho?: boolean
    /** Once the opener is in the journal: the status row says the turn runs. */
    running?: () => Promise<void> | void
  } = {}
): Promise<void> {
  const { host, acquire, dispatch } = hostTestState()
  const events = acquire.mock.calls.at(-1)?.[0].events
  const scope = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const turnId = input.turnId ?? 'turn-1'
  const turn = { ...TURN, turnId }
  const sent = dispatch.mock.calls.at(-1)?.[0].clientMessageId
  const echo = { provider: 'claude' as const, sessionId: 'claude-session', uuid: turnId }
  if (input.claudeEcho && sent) {
    const journal = (
      await (await host.journalReads(HOST_TEST_SESSION)).operationWindow({ afterSequence: 0 })
    ).snapshot
    const message = journal.items.find((item) => item.itemId === agentJournalSubmissionKey(sent))
    if (message) {
      events?.appendItem(echo, message.body, scope)
    }
  }
  const userItemId = input.opener
    ? agentJournalItemKey({ ...turn, turnId: `${turnId}-opener`, ordinal: 0 })
    : input.claudeEcho
      ? agentJournalItemKey(echo)
      : sent
        ? agentJournalSubmissionKey(sent)
        : undefined
  const userMessage = (source: AgentMessageSource | 'person') => ({
    kind: 'message' as const,
    role: 'user' as const,
    // Never a delivery's words, which would make it that delivery's echo.
    blocks: [{ type: 'text' as const, text: 'typed in Orca' }],
    ...(source === 'person' ? {} : { from: source })
  })
  if (input.opener) {
    events?.appendItem(
      { ...turn, turnId: `${turnId}-opener`, ordinal: 0 },
      userMessage(input.opener),
      scope
    )
  }
  events?.appendItem(turn, { kind: 'turn', turnId, state: 'running', userItemId }, scope)
  if (input.running) {
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    await input.running()
  }
  if (input.steer) {
    events?.appendItem({ ...turn, ordinal: 4 }, userMessage(input.steer), {
      turnScope: { kind: 'turn', turnItemId: turnId }
    })
  }
  events?.appendItem(
    { ...turn, ordinal: 2 },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
    scope
  )
  events?.appendItem(
    { ...turn, ordinal: 3 },
    { kind: 'turn', turnId, state: 'completed', outcome: 'success', userItemId },
    scope
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
}

// A turn that fails before the agent says anything, as Codex at its usage limit.
export async function failTurn(): Promise<void> {
  const { host, acquire, dispatch } = hostTestState()
  const events = acquire.mock.calls.at(-1)?.[0].events
  const scope = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const sent = dispatch.mock.calls.at(-1)?.[0].clientMessageId
  const userItemId = sent ? agentJournalSubmissionKey(sent) : undefined
  events?.appendItem(TURN, { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId }, scope)
  events?.appendItem(
    { ...TURN, ordinal: 2 },
    {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        {
          kind: 'usageLimitReached',
          usageLimit: { window: 'weekly', resetsAt: 1_900_000_000_000 }
        },
        { surface: 'row', agentName: 'Codex' }
      )
    },
    scope
  )
  events?.appendItem(
    { ...TURN, ordinal: 3 },
    { kind: 'turn', turnId: 'turn-1', state: 'completed', outcome: 'failure', userItemId },
    scope
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
}
