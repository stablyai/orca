import { describe, expect, it, vi } from 'vitest'
import { claudeQuestionItems } from './claude-structured-prompt-items'

const LAYOUT_A = '┌──────┬────────┐\n│ nav  │ main   │\n└──────┴────────┘'

describe('claudeQuestionItems', () => {
  it('keeps option previews on single-select questions only', () => {
    const [item] = claudeQuestionItems({
      sessionId: 'session-1',
      prompt: {
        requestId: 'req-1',
        promptKey: 'req-1',
        toolUseId: 'toolu-1',
        toolName: 'AskUserQuestion',
        kind: 'question',
        input: {
          questions: [
            {
              question: 'Which layout?',
              header: 'Layout',
              multiSelect: false,
              options: [
                { label: 'Sidebar', description: 'Nav on the left', preview: LAYOUT_A },
                { label: 'Top bar', description: 'Nav on top', preview: '  \n ' }
              ]
            },
            {
              question: 'Which panes?',
              header: 'Panes',
              multiSelect: true,
              options: [
                { label: 'Files', description: 'File tree', preview: 'files' },
                { label: 'Git', description: 'Changes', preview: 'git' }
              ]
            }
          ]
        },
        suggestions: [],
        questionIds: ['q1', 'q2'],
        settle: vi.fn()
      }
    })
    const questions = item!.body.questions!
    expect(questions[0]!.options.map((option) => option.preview)).toEqual([LAYOUT_A, undefined])
    expect(questions[1]!.options.map((option) => option.preview)).toEqual([undefined, undefined])
  })
})
