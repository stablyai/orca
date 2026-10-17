import { describe, expect, it } from 'vitest'
import { AgentJournalItemBodySchema } from '../../shared/agent-session-journal-schemas'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { codexAsyncQuestionBlock } from './codex-async-question-block'
import { codexJournalItem, codexStreamingJournalItem } from './codex-structured-item-translation'

const questions = [
  { title: 'Which branch?', options: ['main', 'release'] },
  { title: 'Anything else?', options: [] }
]
const item = { type: 'agentMessage', id: 'question-1', delivery: 'async', questions }
const questionBlock = {
  type: 'text',
  text: 'Which branch?\n1. main\n2. release\n\nAnything else?',
  asyncQuestions: questions,
  asyncQuestionId: 'question-1'
}

describe('Codex async questions', () => {
  it('keeps a question-only message and its readable fallback through journal validation', () => {
    const { body, handled } = codexJournalItem(item)
    expect(handled).toBe(true)
    expect(body).toEqual({ kind: 'message', role: 'assistant', blocks: [questionBlock] })
    expect(AgentJournalItemBodySchema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body)
  })

  it('keeps questions alongside streamed and completed prose', () => {
    for (const result of [
      codexStreamingJournalItem(item, 'I am still checking.'),
      codexJournalItem({ ...item, text: 'I am still checking.' })
    ]) {
      expect(result.body).toEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'I am still checking.' }, questionBlock]
      })
    }
  })

  it.each([
    { ...item, delivery: undefined },
    { ...item, delivery: 'sync' },
    { ...item, type: 'userMessage' }
  ])('does not turn other messages into async cards: $type / $delivery', (other) => {
    expect(codexJournalItem({ ...other, text: 'Ordinary message' }).body).toEqual({
      kind: 'message',
      role: other.type === 'userMessage' ? 'user' : 'assistant',
      blocks: [{ type: 'text', text: 'Ordinary message' }]
    })
  })

  it('ignores malformed entries and permits a question with no suggestions', () => {
    expect(
      codexAsyncQuestionBlock([
        null,
        {},
        { title: '  ' },
        { title: 12 },
        { title: 'Describe it' },
        { title: 'Pick one', options: ['One', null, 2, 'Two'] }
      ])
    ).toEqual({
      type: 'text',
      text: 'Describe it\n\nPick one\n1. One\n2. Two',
      asyncQuestions: [
        { title: 'Describe it', options: [] },
        { title: 'Pick one', options: ['One', 'Two'] }
      ]
    })
    expect(codexAsyncQuestionBlock({ title: 'Not an array' })).toBeNull()
    expect(codexAsyncQuestionBlock([null, { title: '' }])).toBeNull()
  })

  it('keeps oversized UTF-8 questions readable without offering truncated answers', () => {
    const block = codexAsyncQuestionBlock([{ title: 'Describe it', options: ['🎵'.repeat(5000)] }])
    expect(block?.asyncQuestions).toBeUndefined()
    expect(block?.text).toContain('Describe it\n1. 🎵')
    expect(block?.text).toContain('output truncated')
    expect(block?.text).not.toContain('\uFFFD')
    expect(Buffer.byteLength(block?.text ?? '', 'utf8')).toBeLessThan(
      DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes + 128
    )
  })
})
