import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { botFirstKickoff } from '../../shared/bots/bot-import'
import { botKickoffFingerprint, kickoffNeedsRetry, retryBotKickoff } from './bot-kickoff-retry'

const CHAT = 'chat-1'

function submission(
  payloadFingerprint: string,
  dispatchState: AgentJournalSubmission['dispatchState'] = 'accepted'
): AgentJournalSubmission {
  return {
    clientMessageId: payloadFingerprint,
    fence: 1,
    payloadFingerprint,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2
  }
}

function item(body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  return {
    itemId: `i-${Math.random()}`,
    revision: 1,
    body,
    sequence: 1,
    observedAt: 1
  }
}

const turn = (state: 'running' | 'interrupted') =>
  item({
    kind: 'turn',
    turnId: 't1',
    state,
    userItemId: 'u1',
    startedAt: 1,
    requestedAt: 1
  })
const toolCall = item({
  kind: 'tool-call',
  name: 'Bash',
  input: {},
  callId: 'c1',
  state: 'completed'
})
const greeting = item({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Hi, what am I for?' }]
})

const kickoff = submission(botKickoffFingerprint(CHAT))

describe('a new bot whose kickoff ended silent', () => {
  it('is sent it again whenever its owner asks, until it speaks or they write', () => {
    const ended = {
      submissions: [kickoff, kickoff],
      items: [turn('interrupted'), turn('interrupted')]
    }
    expect(kickoffNeedsRetry(CHAT, ended)).toBe(false)
    expect(kickoffNeedsRetry(CHAT, ended, true)).toBe(true)
    expect(
      kickoffNeedsRetry(CHAT, { ...ended, submissions: [kickoff, submission('owner')] }, true)
    ).toBe(false)
    expect(kickoffNeedsRetry(CHAT, { ...ended, items: [...ended.items, greeting] }, true)).toBe(
      false
    )
  })

  it('is sent again when its agent failed to start, before any turn opened', () => {
    const refused = {
      submissions: [submission(kickoff.payloadFingerprint, 'rejected')],
      items: [
        item({
          kind: 'status',
          text: "Claude Code couldn't start. Send your message to try again.",
          tone: 'error'
        })
      ]
    }
    expect(kickoffNeedsRetry(CHAT, refused)).toBe(true)
    expect(kickoffNeedsRetry(CHAT, refused, true)).toBe(true)
  })

  it('refuses Try again while the last kickoff is still on its way', () => {
    const first = [turn('interrupted')]
    // Sent but not taken yet, or taken with its turn not open yet.
    for (const resend of [submission(kickoff.payloadFingerprint, 'pending'), kickoff]) {
      expect(kickoffNeedsRetry(CHAT, { submissions: [kickoff, resend], items: first }, true)).toBe(
        false
      )
    }
  })

  it('leaves a running, greeted or not-yet-started kickoff alone', () => {
    expect(
      kickoffNeedsRetry(CHAT, {
        submissions: [kickoff],
        items: [turn('running')]
      })
    ).toBe(false)
    expect(
      kickoffNeedsRetry(CHAT, {
        submissions: [kickoff],
        items: [turn('interrupted'), greeting]
      })
    ).toBe(false)
    // Not taken yet: nothing has ended.
    expect(kickoffNeedsRetry(CHAT, { submissions: [kickoff], items: [] })).toBe(false)
  })

  it('sends once for two opens at once, and never for a bot set up already', async () => {
    let release = (): void => {}
    const snapshot = vi.fn(async () => {
      await new Promise<void>((resolve) => (release = resolve))
      // Stop after a tool call and before a greeting still permits one retry.
      return { submissions: [kickoff], items: [turn('interrupted'), toolCall] }
    })
    const fingerprints = async () => [
      { clientMessageId: kickoff.clientMessageId, fingerprint: kickoff.payloadFingerprint }
    ]
    const send = vi.fn(async () => {})
    const bot = { id: 'b1', name: 'Scout', firstRun: true as const, chatSessionId: CHAT }
    const both = Promise.all([
      retryBotKickoff(bot, { fingerprints, snapshot, send }),
      retryBotKickoff(bot, { fingerprints, snapshot, send })
    ])
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled())
    release()
    expect(await both).toEqual([true, false])
    expect(send).toHaveBeenCalledOnce()

    expect(
      await retryBotKickoff({ ...bot, firstRun: undefined }, { fingerprints, snapshot, send })
    ).toBe(false)
    expect(send).toHaveBeenCalledOnce()
  })

  it("sends an imported bot's own first turn again, not the usual setup", async () => {
    const bot = {
      id: 'b1',
      name: 'Molty',
      firstRun: true as const,
      chatSessionId: CHAT,
      importedFrom: { app: 'openclaw' as const, path: '/h/.openclaw/workspace', agent: 'main' }
    }
    const kickoffText = botFirstKickoff(bot)
    expect(kickoffText).toContain('take over "Molty" from OpenClaw')
    const fingerprint = botKickoffFingerprint(CHAT, kickoffText)
    const fingerprints = async () => [{ clientMessageId: 'kickoff', fingerprint }]
    const snapshot = async () => ({
      submissions: [submission(fingerprint)],
      items: [turn('interrupted')]
    })
    const send = vi.fn(async () => {})
    expect(await retryBotKickoff(bot, { fingerprints, snapshot, send })).toBe(true)
  })
})
