import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { AgentMessageSource } from '../../shared/agent-session/journal/agent-session-message-source'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { chatPaneKey, deliverToChat, stopChat } from './external-conversation-chat'
import { answerChatPrompt, pendingChatPrompt } from './external-conversation-chat-prompts'
import { findLink, readLinks } from './external-conversation-links'
import { writeLinkFact } from './external-conversation-link-writes'
import { agentReady, harness } from './external-conversation-seam.test-fixture'
import { WORKTREE } from './external-conversation.test-fixture'

// The real native-chat host over a fake provider: the seam's envelopes must pass its admission.
const LINK: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C9:1:U5',
  paneKey: chatPaneKey(HOST_TEST_SESSION),
  sessionId: HOST_TEST_SESSION,
  agent: 'codex',
  createdAt: 1
}
const live = new AbortController().signal

beforeEach(() => {
  // The host refuses operation ids minted far from its own clock.
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a chat-linked conversation on the native-chat host', () => {
  it('sends the delivery as the person’s message', async () => {
    const { host, dispatch } = hostTestState()
    await attach()

    await expect(
      deliverToChat(host, LINK, { text: 'From Slack: ship it', signal: live })
    ).resolves.toEqual({ outcome: 'accepted' })

    // The chat takes the message, then its delivery loop dispatches it.
    await eventually(() => expect(dispatch).toHaveBeenCalledOnce())
    expect(dispatch.mock.calls[0]?.[0].body).toEqual({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'From Slack: ship it' }]
    })
  })

  it('refuses a send to a deleted chat as gone, so its thread can start anew', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const deleted = {
      ...LINK,
      sessionId: 'deleted-session',
      paneKey: chatPaneKey('deleted-session')
    }

    await expect(
      deliverToChat(host, deleted, { text: 'still there?', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'chat_gone' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses before sending once the conversation is cancelled', async () => {
    const { host, dispatch } = hostTestState()
    await attach()
    const cancelled = new AbortController()
    cancelled.abort('conversation_cancelled')

    await expect(
      deliverToChat(host, LINK, { text: 'late', signal: cancelled.signal })
    ).resolves.toEqual({ outcome: 'refused', reason: 'conversation_cancelled' })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('reads a pending approval with its own options and answers it', async () => {
    const { host, answerPrompt } = hostTestState()
    await attach()
    const { itemId } = await seedApproval('allow')

    expect(pendingChatPrompt(host, LINK)).toEqual({
      kind: 'approval',
      promptId: itemId,
      tool: 'Run the command?',
      options: [{ id: 'allow', label: 'Allow' }]
    })
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, optionId: 'deny', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'option_not_offered' })
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, optionId: 'allow', signal: live })
    ).resolves.toEqual({ outcome: 'accepted' })
    expect(answerPrompt).toHaveBeenCalledOnce()
    // The connector reads the prompt as of the chat's next status publish.
    await eventually(() => expect(pendingChatPrompt(host, LINK)).toBeNull())
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, optionId: 'allow', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'prompt_not_pending' })
  })

  it('stops a chat waiting on the user with its own Stop, and leaves an idle one alone', async () => {
    const { host, cancelTurn } = hostTestState()
    await attach()
    await expect(stopChat(host, LINK, live)).resolves.toEqual({ outcome: 'accepted' })
    expect(cancelTurn).not.toHaveBeenCalled()

    await seedApproval()
    await agentReady(host, HOST_TEST_SESSION)
    await expect(stopChat(host, LINK, live)).resolves.toEqual({ outcome: 'accepted' })
    expect(cancelTurn).toHaveBeenCalledOnce()
    await eventually(() => expect(pendingChatPrompt(host, LINK)).toBeNull())
  })

  it('refuses sends and answers while no native-chat host is installed', async () => {
    await expect(deliverToChat(null, LINK, { text: 'x', signal: live })).resolves.toEqual({
      outcome: 'refused',
      reason: 'agent_not_reachable'
    })
    expect(pendingChatPrompt(null, LINK)).toBeNull()
    await expect(
      answerChatPrompt(null, LINK, { promptId: 'p', optionId: 'o', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'prompt_not_pending' })
    // Nothing runs without a host, so there is nothing to stop.
    await expect(stopChat(null, LINK, live)).resolves.toEqual({ outcome: 'accepted' })
  })

  it('records a Slack send that lands after sign-out released the watch as the thread’s turn', async () => {
    const { host } = hostTestState()
    await attach()
    const { seam, store } = harness()
    const key = { source: LINK.source, externalId: LINK.externalId }
    const bot = { kind: 'bot' as const, botId: 'b1' }
    seam.linkChat(key, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex', bot })
    writeLinkFact(store, key, { lastTurn: 'orca' })
    let installed!: () => void
    const ensure = new Promise<void>((resolve) => (installed = resolve))
    const chat = {
      current: () => host,
      ensure: () => ensure.then(() => host),
      onChanged: () => () => {}
    }
    const release = seam.watch({ chat }, () => {})
    const bots = { refusal: () => null, open: vi.fn(), workLinks: async () => [] }
    const sent = seam.send({ chat, bots }, key, 'd1', { text: 'from Slack' })

    release()
    installed()

    await expect(sent).resolves.toEqual({ outcome: 'accepted' })
    expect(findLink(store, key)?.link.lastTurn).toBe('conversation')
  })

  // Each message a chat takes names its turn's source by itself, with or without a connector watch.
  it('records the latest turn as the thread’s only when a delivery or its workers’ report began or joined it', () => {
    const { seam, store } = harness()
    const key = { source: LINK.source, externalId: LINK.externalId }
    const bot = { kind: 'bot' as const, botId: 'b1' }
    seam.linkChat(key, { worktreeId: WORKTREE, sessionId: HOST_TEST_SESSION, agent: 'codex', bot })
    const report = (toConversation: boolean): AgentMessageSource => ({
      kind: 'agent',
      senders: [
        {
          party: { address: 'dispatch:d1', terminalHandle: null, orcaSessionId: null },
          name: 'Worker',
          relation: 'worker',
          ...(toConversation ? { toConversation: true as const } : {})
        }
      ],
      orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
    })
    const message = (fields: Partial<AgentJournalMessageItem> = {}): AgentJournalMessageItem => ({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
      ...fields
    })
    const take = (body: AgentJournalMessageItem, joinsRunningTurn = false) => {
      seam.messageAdmitted({
        sessionId: HOST_TEST_SESSION,
        workspaceId: WORKTREE,
        clientMessageId: 'send-1',
        body,
        joinsRunningTurn
      })
      return readLinks(store, { worktreeId: WORKTREE, sshHostId: null })[0]?.lastTurn
    }
    const slack = message({ origin: 'connector' })

    expect(take(message())).toBe('orca') // typed in Orca, or an automation's prompt
    expect(take(slack)).toBe('conversation')
    expect(take(message(), true)).toBe('conversation') // typed into the thread's running turn
    expect(take(message({ from: report(false) }))).toBe('orca') // mail, as from an in-app worker
    expect(take(slack, true)).toBe('conversation') // the thread joins Orca's running turn
    expect(take(message({ from: report(true) }))).toBe('conversation') // its workers' report
    // Finding the chat's link reads only its own workspace, never every workspace's links.
    const inventory = [
      vi.spyOn(store, 'getAllWorktreeMetaForHost'),
      vi.spyOn(store, 'getAllWorktreeMeta'),
      vi.spyOn(store, 'getFolderWorkspaces')
    ]
    expect(take(message({ from: report(true) }))).toBe('conversation')
    inventory.forEach((read) => expect(read).not.toHaveBeenCalled())
  })
})
