import { describe, expect, it } from 'vitest'
import {
  buildAskAnswerKeys,
  extractPendingAsk,
  formatAskAnswer,
  parseAskFromStatus
} from '../../../src/shared/native-chat-ask'
import { buildGrokAskAnswerKeys } from '../../../src/shared/native-chat-grok-ask-answer'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

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

  it('parses the captured Grok ask_user_question envelope and options', () => {
    // Captured from ~/.grok/sessions/.../chat_history.jsonl. Keep the
    // {questions:[...]} envelope: Grok does not send a bare array here.
    const grokInput = {
      questions: [
        {
          question: 'How should we proceed with the 0.0.41 mobile release?',
          options: [
            {
              label: 'Both platforms (Recommended)',
              description:
                'iOS: App Store Connect with existing TestFlight 0.0.41; Android: trigger release workflow'
            },
            {
              label: 'iOS only',
              description: 'Prepare App Store Connect copy; no Android CI.'
            },
            {
              label: 'Android only',
              description: 'Tag/dispatch Mobile Android Release with release_version 0.0.41'
            },
            {
              label: 'Status only for now',
              description: 'Stop here; I’ll handle ASC/Android myself with the drafts above'
            }
          ],
          multi_select: false
        },
        {
          question: 'How should we trigger the Android release (if shipping Android)?',
          options: [
            {
              label: 'Tag push mobile-android-v0.0.41 (Recommended)',
              description: 'git tag on origin/main and push'
            },
            {
              label: 'workflow_dispatch',
              description: 'Dispatch Mobile Android Release with release_version 0.0.41'
            },
            { label: 'N/A — not shipping Android', description: 'Skip Android trigger' }
          ],
          multi_select: false
        }
      ]
    }
    const ask = parseAskFromStatus(JSON.stringify(grokInput), 'ask_user_question')
    expect(ask?.questions).toHaveLength(2)
    expect(
      ask?.questions.flatMap((question) => question.options.map((option) => option.label))
    ).toEqual([
      'Both platforms (Recommended)',
      'iOS only',
      'Android only',
      'Status only for now',
      'Tag push mobile-android-v0.0.41 (Recommended)',
      'workflow_dispatch',
      'N/A — not shipping Android'
    ])
    expect(ask?.questions.every((question) => question.multiSelect)).toBe(false)
  })

  it('maps Grok multi_select to the selector flag', () => {
    const capturedShapeWithMultiSelect = {
      questions: [
        {
          question: 'Pick release targets',
          options: [{ label: 'iOS' }, { label: 'Android' }],
          multi_select: true
        }
      ]
    }
    const ask = parseAskFromStatus(
      JSON.stringify(capturedShapeWithMultiSelect),
      'ask_user_question'
    )
    expect(ask?.questions[0]?.multiSelect).toBe(true)
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

describe('buildGrokAskAnswerKeys', () => {
  it('selects and submits a single-question single-select answer', () => {
    const prompt = {
      questions: [
        { question: 'q', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] }
      ]
    }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [1] }])).toEqual([{ raw: '2' }])
  })

  it('lets each Grok single-select digit advance or submit', () => {
    const prompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2' },
      { raw: '1' }
    ])
  })

  it('toggles Grok multi-select rows with Space before submitting', () => {
    const prompt = {
      questions: [
        {
          question: 'q',
          multiSelect: true,
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }]
        }
      ]
    }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [0, 2] }])).toEqual([
      { raw: ' ' },
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { raw: ' ' },
      { raw: '\r' }
    ])
  })

  it('opens Grok free text with z before typing and submitting', () => {
    const prompt = {
      questions: [{ question: 'q', multiSelect: false, options: [{ label: 'A' }] }]
    }
    expect(buildGrokAskAnswerKeys(prompt, [{ indices: [], other: 'custom' }])).toEqual([
      { raw: 'z' },
      { text: 'custom' },
      { raw: '\r' }
    ])
  })
})
