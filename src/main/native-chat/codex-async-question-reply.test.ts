import { describe, expect, it } from 'vitest'
import {
  createNativeChatAsyncQuestionFoldState,
  foldNativeChatAsyncQuestionFact,
  nativeChatAsyncQuestionKey,
  nativeChatAsyncQuestionsFromFold
} from '../../shared/native-chat-async-questions'
import {
  codexUserRecordReplyText,
  parseCodexAsyncQuestionReplyIds
} from './codex-async-question-reply'
import { codexRolloutAsyncQuestionFacts } from './codex-rollout-async-question-facts'

// What Codex's question editor records (context-fragments answered_question.rs render()).
const envelope = (replies: unknown): string =>
  `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`
const reply = (questionItemId: string): Record<string, string> => ({
  answer: 'blue',
  question: 'Color?',
  questionItemId
})
const keyA0 = nativeChatAsyncQuestionKey('call-a', 0)

describe('parseCodexAsyncQuestionReplyIds', () => {
  it('reads the ids of a list or a single reply', () => {
    expect(parseCodexAsyncQuestionReplyIds(envelope([reply(keyA0), reply('call-b')]))).toEqual([
      keyA0,
      'call-b'
    ])
    expect(parseCodexAsyncQuestionReplyIds(envelope(reply(keyA0)))).toEqual([keyA0])
  })

  it('accepts the IDE context prefix only before the request heading', () => {
    const text = `# Context from my IDE setup:\n\nfile.ts\n\n## My request for Codex:\n${envelope([reply(keyA0)])}\n`
    expect(parseCodexAsyncQuestionReplyIds(text)).toEqual([keyA0])
    expect(
      parseCodexAsyncQuestionReplyIds(`# Context from my IDE setup:\n${envelope([reply(keyA0)])}`)
    ).toBeNull()
  })

  it('treats anything but a complete, well-formed envelope as an ordinary prompt', () => {
    expect(parseCodexAsyncQuestionReplyIds('Question: Color?\nAnswer: blue')).toBeNull()
    expect(parseCodexAsyncQuestionReplyIds(`see ${envelope([reply(keyA0)])}`)).toBeNull()
    expect(parseCodexAsyncQuestionReplyIds(envelope([]))).toBeNull()
    expect(
      parseCodexAsyncQuestionReplyIds(envelope([{ answer: 'x', questionItemId: 'a' }]))
    ).toBeNull()
    expect(parseCodexAsyncQuestionReplyIds(envelope([reply('a'), { question: 'q' }]))).toBeNull()
    expect(
      parseCodexAsyncQuestionReplyIds(
        '<send_user_message_question_reply>{</send_user_message_question_reply>'
      )
    ).toBeNull()
  })
})

describe('codexUserRecordReplyText', () => {
  it('reads one text input, ignoring skills and mentions, as Codex does', () => {
    const item = (content: unknown[]) => ({
      type: 'item_completed',
      item: { type: 'UserMessage', content }
    })
    expect(
      codexUserRecordReplyText(
        item([
          { type: 'skill', name: 's', path: 'p' },
          { type: 'text', text: 'hi' }
        ])
      )
    ).toBe('hi')
    expect(
      codexUserRecordReplyText(
        item([
          { type: 'text', text: 'hi' },
          { type: 'image', url: 'x' }
        ])
      )
    ).toBeNull()
    expect(codexUserRecordReplyText({ type: 'user_message', message: 'hi' })).toBe('hi')
  })
})

describe('reply facts in the shared fold', () => {
  const asked = (itemId: string | undefined, titles: string[], recordId = `r:${itemId}`) =>
    foldFacts([
      {
        kind: 'asked' as const,
        asker: 'root' as const,
        recordId,
        ...(itemId ? { itemId } : {}),
        questions: titles.map((title) => ({ title }))
      }
    ])
  let state = createNativeChatAsyncQuestionFoldState()
  function foldFacts(facts: Parameters<typeof foldNativeChatAsyncQuestionFact>[1][]): void {
    for (const fact of facts) {
      foldNativeChatAsyncQuestionFact(state, fact)
    }
  }
  const pendingTitles = () => nativeChatAsyncQuestionsFromFold(state).map((q) => q.title)

  it('retires only the named question; the others keep their keys', () => {
    state = createNativeChatAsyncQuestionFoldState()
    asked('call-a', ['Color?', 'Shade?'])
    asked('call-b', ['Size?'])
    foldFacts([{ kind: 'answered', ids: [keyA0] }])
    expect(pendingTitles()).toEqual(['Shade?', 'Size?'])
    expect(nativeChatAsyncQuestionsFromFold(state).map((q) => q.key)).toEqual([
      nativeChatAsyncQuestionKey('call-a', 1),
      nativeChatAsyncQuestionKey('call-b', 0)
    ])
    // A whole item id answers every question of that message.
    foldFacts([{ kind: 'answered', ids: ['call-b'] }])
    expect(pendingTitles()).toEqual(['Shade?'])
  })

  it('retires record-position entries on any reply, since no reply can name them', () => {
    state = createNativeChatAsyncQuestionFoldState()
    asked(undefined, ['Legacy?'], '/rollout.jsonl:0000000000000042')
    asked('call-b', ['Size?'])
    foldFacts([{ kind: 'answered', ids: ['unrelated'] }])
    expect(pendingTitles()).toEqual(['Size?'])
  })

  it('still clears everything on a plain delivered prompt', () => {
    state = createNativeChatAsyncQuestionFoldState()
    asked('call-a', ['Color?'])
    asked('call-b', ['Size?'])
    foldFacts([{ kind: 'delivered-user-message', author: 'root' }])
    expect(pendingTitles()).toEqual([])
  })
})

describe('codexRolloutAsyncQuestionFacts on user records', () => {
  it('emits an answered fact for an editor reply and clear-all for a prompt', () => {
    const userEvent = (message: string) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message } })
    expect(codexRolloutAsyncQuestionFacts(userEvent(envelope([reply(keyA0)])), 'r')).toEqual([
      { kind: 'answered', ids: [keyA0] }
    ])
    expect(
      codexRolloutAsyncQuestionFacts(userEvent('Question: Color?\nAnswer: blue'), 'r')
    ).toEqual([{ kind: 'delivered-user-message', author: 'root' }])
  })
})
