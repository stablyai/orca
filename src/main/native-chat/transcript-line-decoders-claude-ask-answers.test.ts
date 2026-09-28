import { describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  CLAUDE_DECLINED_CONTENT,
  CLAUDE_DECLINED_RESULTS,
  CLAUDE_RECORDED_MULTI_SELECT_LIST,
  CLAUDE_RECORDED_PREVIEW_ANSWER,
  CLAUDE_RECORDED_TYPED_ANSWER
} from '../../shared/native-chat-ask-answers.test-fixture'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'

// The record keys and block shape of a Claude Code AskUserQuestion result line;
// every value is synthetic. The model reads the prose `content`; the answers sit
// beside it as data in `toolUseResult`. The answer rules are tested where they live.
function resultLine(toolUseResult: unknown, content: string, isError = false): string {
  return JSON.stringify({
    parentUuid: 'parent-uuid',
    isSidechain: false,
    promptId: 'prompt-id',
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content,
          ...(isError ? { is_error: true } : {}),
          tool_use_id: 'toolu_synthetic'
        }
      ]
    },
    uuid: 'result-uuid',
    timestamp: '2026-09-20T10:00:00.000Z',
    toolUseResult,
    sourceToolAssistantUUID: 'assistant-uuid',
    userType: 'external',
    entrypoint: 'cli',
    cwd: '/tmp/project',
    sessionId: 'session-id',
    version: '2.1.280',
    gitBranch: 'main'
  })
}

function resultBlock(line: string): NativeChatBlock | undefined {
  return decodeClaudeTranscriptLine(line, 'fallback')?.blocks[0]
}

describe('Claude AskUserQuestion answers', () => {
  it('attaches the answers of a recorded result, keyed by each question', () => {
    expect(
      resultBlock(
        resultLine(CLAUDE_RECORDED_MULTI_SELECT_LIST, 'User has answered your questions.')
      )
    ).toMatchObject({
      type: 'tool-result',
      output: 'User has answered your questions.',
      askAnswers: [
        { question: 'Which storage for the cache?', answer: ['On disk'] },
        { question: 'Which checks run?', answer: ['Lint', 'Tests'] }
      ]
    })
  })

  it('attaches recorded typed text and reads past a recorded preview', () => {
    expect(
      resultBlock(resultLine(CLAUDE_RECORDED_TYPED_ANSWER, 'User has answered your questions.'))
    ).toMatchObject({
      askAnswers: [
        {
          question: 'How should the importer treat duplicate rows?',
          answer: ['Merge them, "newest" wins']
        }
      ]
    })
    expect(
      resultBlock(resultLine(CLAUDE_RECORDED_PREVIEW_ANSWER, 'User has answered your questions.'))
    ).toMatchObject({
      askAnswers: [
        { question: 'Which layout for the header?', answer: ['Stacked'] },
        { question: 'Ship it behind a flag?', answer: ['Yes'] }
      ]
    })
  })

  it('attaches no answers to a recorded declined ask', () => {
    for (const declined of CLAUDE_DECLINED_RESULTS) {
      const block = resultBlock(resultLine(declined, CLAUDE_DECLINED_CONTENT, true))
      expect(block).toMatchObject({ type: 'tool-result', isError: true })
      expect(block).not.toHaveProperty('askAnswers')
    }
  })

  it('attaches no answers to a result of a shape it does not recognize', () => {
    const block = resultBlock(
      resultLine(
        { ...CLAUDE_RECORDED_MULTI_SELECT_LIST, submittedBy: 'someone' },
        'User has answered your questions.'
      )
    )
    expect(block).toMatchObject({ type: 'tool-result' })
    expect(block).not.toHaveProperty('askAnswers')
  })

  it('still attaches resolved hunks to an edit result', () => {
    const block = resultBlock(
      resultLine(
        {
          filePath: '/tmp/a.ts',
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }
          ]
        },
        'The file has been updated.'
      )
    )
    expect(block).toMatchObject({
      editPatch: {
        filePath: '/tmp/a.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
      }
    })
    expect(block).not.toHaveProperty('askAnswers')
  })
})
