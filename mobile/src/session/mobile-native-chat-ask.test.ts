import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  buildAskAnswerKeys,
  extractPendingAsk,
  formatAskAnswer,
  parseAskFromStatus
} from './mobile-native-chat-ask'

function msg(blocks: NativeChatMessage['blocks'], id = 'm'): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 0, source: 'transcript' }
}

const askInput = {
  questions: [
    {
      question: 'Pick one',
      header: 'Choice',
      multiSelect: false,
      options: [
        { label: 'A', description: 'first' },
        { label: 'B', description: 'second' }
      ]
    }
  ]
}

describe('extractPendingAsk', () => {
  it('returns the structured prompt from a pending AskUserQuestion call', () => {
    const ask = extractPendingAsk([
      msg([{ type: 'tool-call', name: 'AskUserQuestion', input: askInput }])
    ])
    expect(ask?.questions[0]).toMatchObject({
      question: 'Pick one',
      header: 'Choice',
      multiSelect: false
    })
    expect(ask?.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'B'])
  })

  it('returns null once a tool-result follows the ask', () => {
    const ask = extractPendingAsk([
      msg([{ type: 'tool-call', name: 'AskUserQuestion', input: askInput }], 'a'),
      msg([{ type: 'tool-result', output: 'answered' }], 'r')
    ])
    expect(ask).toBeNull()
  })

  it('ignores non-ask tool calls', () => {
    expect(
      extractPendingAsk([msg([{ type: 'tool-call', name: 'Bash', input: { command: 'ls' } }])])
    ).toBeNull()
  })

  it('survives an unrelated earlier tool result (FIFO, not adjacency)', () => {
    // A parallel Bash call precedes the ask; its result resolves the Bash call
    // (oldest outstanding), so the unanswered question must remain pending.
    const ask = extractPendingAsk([
      msg([{ type: 'tool-call', name: 'Bash', input: { command: 'ls' } }], 'c1'),
      msg([{ type: 'tool-call', name: 'AskUserQuestion', input: askInput }], 'a1'),
      msg([{ type: 'tool-result', output: 'ls output' }], 'r1')
    ])
    expect(ask?.questions[0]!.question).toBe('Pick one')
  })

  it("clears the ask only when the ask's own result arrives", () => {
    const ask = extractPendingAsk([
      msg([{ type: 'tool-call', name: 'Bash', input: { command: 'ls' } }], 'c1'),
      msg([{ type: 'tool-call', name: 'AskUserQuestion', input: askInput }], 'a1'),
      msg([{ type: 'tool-result', output: 'ls output' }], 'r1'),
      msg([{ type: 'tool-result', output: 'answered' }], 'r2')
    ])
    expect(ask).toBeNull()
  })

  it('keeps the latest ask when several appear', () => {
    const ask = extractPendingAsk([
      msg([{ type: 'tool-call', name: 'AskUserQuestion', input: askInput }], 'a1'),
      msg([{ type: 'tool-result', output: 'x' }], 'r1'),
      msg([
        {
          type: 'tool-call',
          name: 'AskUserQuestion',
          input: {
            questions: [{ question: 'Second', multiSelect: false, options: [{ label: 'Z' }] }]
          }
        }
      ])
    ])
    expect(ask?.questions[0]!.question).toBe('Second')
  })
})

describe('parseAskFromStatus', () => {
  it('parses the live interactivePrompt JSON into a prompt', () => {
    const ask = parseAskFromStatus(JSON.stringify(askInput))
    expect(ask?.questions[0]!.options.map((o) => o.label)).toEqual(['A', 'B'])
  })

  it('returns null for empty or malformed input', () => {
    expect(parseAskFromStatus(undefined)).toBeNull()
    expect(parseAskFromStatus('')).toBeNull()
    expect(parseAskFromStatus('{not json')).toBeNull()
    expect(parseAskFromStatus('{"foo":1}')).toBeNull()
  })
})

describe('formatAskAnswer', () => {
  it('joins selected labels per question', () => {
    const prompt = {
      questions: [
        { question: 'q1', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }] }
      ]
    }
    expect(formatAskAnswer(prompt, [{ indices: [0, 1] }, { indices: [0] }])).toBe('A, B\nC')
  })

  it('keeps one line per question with a blank middle answer (3 questions)', () => {
    const prompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'B' }] },
        { question: 'q3', multiSelect: false, options: [{ label: 'C' }] }
      ]
    }
    const answer = formatAskAnswer(prompt, [{ indices: [0] }, { indices: [] }, { indices: [0] }])
    expect(answer).toBe('A\n\nC')
    expect(answer.split('\n')).toHaveLength(3)
  })
})

describe('buildAskAnswerKeys', () => {
  it('answers a single-select pick with its option number only', () => {
    const prompt = {
      questions: [
        { question: 'q', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }
      ]
    }
    expect(buildAskAnswerKeys(prompt, [{ indices: [1] }])).toEqual([{ raw: '2' }])
  })

  it('toggles multi-select numbers then steps to Submit and confirms', () => {
    const prompt = {
      questions: [
        {
          question: 'q',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
        }
      ]
    }
    expect(buildAskAnswerKeys(prompt, [{ indices: [0, 2] }])).toEqual([
      { raw: '1' },
      { raw: '3' },
      { raw: '\x1b[C' },
      { raw: '\r' }
    ])
  })
})
