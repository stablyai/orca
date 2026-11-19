import { describe, expect, it, vi } from 'vitest'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { answerConversation, type AnswerSeam } from './external-conversation-answer'
import type { Delivery } from './external-conversation-types'

const LINK: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C9:1',
  sessionId: 'chat-1',
  paneKey: 'pane-1',
  agent: 'claude',
  createdAt: 1
}

vi.mock('./external-conversation-links', () => ({
  requireLink: () => ({ workspace: { worktreeId: 'wt', sshHostId: null }, link: LINK })
}))

const answerChatPrompt = vi.hoisted(() => vi.fn<() => Promise<Delivery>>())
vi.mock('./external-conversation-chat-prompts', () => ({ answerChatPrompt }))

function answering(answer: () => Promise<Delivery>) {
  const keep = vi.fn()
  answerChatPrompt.mockImplementation(answer)
  const seam = {
    store: {},
    events: { answering: vi.fn(() => keep) }
  }
  const run = () =>
    answerConversation(
      {},
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answerConversation reads only store (mocked requireLink) and events.answering.
      seam as unknown as AnswerSeam,
      { source: 'slack', externalId: 'T1:C9:1' },
      { promptId: 'q1', optionId: 'allow_once', signal: new AbortController().signal }
    )
  return { run, keep, seam }
}

describe('a connector’s answer to its agent’s prompt', () => {
  it('stops the prompt being told as answered in Orca once the answer landed', async () => {
    const { run, keep, seam } = answering(async () => ({ outcome: 'accepted' }))
    await expect(run()).resolves.toEqual({ outcome: 'accepted' })
    expect(seam.events.answering).toHaveBeenCalledWith('pane-1', 'q1')
    expect(keep).not.toHaveBeenCalled()
  })

  it.each<[string, () => Promise<Delivery>]>([
    ['is refused', async () => ({ outcome: 'refused', reason: 'prompt_not_pending' })],
    ['may not have landed', async () => ({ outcome: 'unknown', reason: 'writer_failed' })]
  ])('keeps following the prompt when the answer %s', async (_case, answer) => {
    const { run, keep } = answering(answer)
    await run()
    expect(keep).toHaveBeenCalledOnce()
  })

  it('keeps following the prompt when the answer throws, and still throws', async () => {
    const { run, keep } = answering(async () => {
      throw new Error('external_conversation_not_found')
    })
    await expect(run()).rejects.toThrow('external_conversation_not_found')
    expect(keep).toHaveBeenCalledOnce()
  })
})
