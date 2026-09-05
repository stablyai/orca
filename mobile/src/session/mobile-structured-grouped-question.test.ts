import { describe, expect, it } from 'vitest'
import type { AgentJournalQuestion } from '../../../src/shared/agent-session-journal-types'
import { decodeAgentSessionQuestionAnswers } from '../../../src/shared/agent-session-question-answer'
import {
  formatQuestionAnswer,
  formatQuestionFreeTextAnswer,
  mobileChatQuestionKey
} from './mobile-native-chat-question'
import {
  advanceGroupedQuestion,
  groupedQuestionPromptKey,
  projectGroupedQuestion,
  type GroupedQuestionDraft
} from './mobile-structured-grouped-question'

const PROMPT_KEY = groupedQuestionPromptKey('item-1', 3)

function question(overrides: Partial<AgentJournalQuestion> = {}): AgentJournalQuestion {
  return {
    id: 'q1',
    question: 'Which database?',
    multiSelect: false,
    options: [
      { id: 'q1:choice-1', label: 'Postgres' },
      { id: 'q1:choice-2', label: 'SQLite' }
    ],
    freeTextQuestionId: 'q1',
    ...overrides
  }
}

const SECOND = question({
  id: 'q2',
  question: 'Which regions?',
  multiSelect: true,
  options: [
    { id: 'q2:choice-1', label: 'us-east' },
    { id: 'q2:choice-2', label: 'eu-west' }
  ],
  freeTextQuestionId: 'q2'
})

/** Mirrors what the question card sends back for a single-select tap. */
function tapOption(projected: NonNullable<ReturnType<typeof projectGroupedQuestion>>, at: number) {
  return projected.optionTokens[at] ?? ''
}

describe('mobile structured grouped questions', () => {
  it('projects the first question with real options instead of the empty flat shape', () => {
    const projected = projectGroupedQuestion([question(), SECOND], null, PROMPT_KEY)

    expect(projected).toMatchObject({
      question: 'Which database? (1 of 2)',
      options: ['Postgres', 'SQLite'],
      multiSelect: false,
      allowOther: true
    })
    expect(projected?.optionTokens.every((token) => Boolean(token))).toBe(true)
    expect(projected?.freeTextToken).toBeTruthy()
  })

  it('steps to the next question once the first is answered, without sending anything', () => {
    const questions = [question(), SECOND]
    const first = projectGroupedQuestion(questions, null, PROMPT_KEY)!

    const advance = advanceGroupedQuestion({
      response: tapOption(first, 0),
      questions,
      draft: null,
      promptKey: PROMPT_KEY
    })

    expect(advance).toEqual({
      kind: 'advance',
      draft: { promptKey: PROMPT_KEY, answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }] }
    })
    const second = projectGroupedQuestion(
      questions,
      advance!.kind === 'advance' ? advance.draft : null,
      PROMPT_KEY
    )
    expect(second).toMatchObject({ question: 'Which regions? (2 of 2)', multiSelect: true })
  })

  it('submits the whole group as one encoded answer on the last step', () => {
    const questions = [question(), SECOND]
    const draft: GroupedQuestionDraft = {
      promptKey: PROMPT_KEY,
      answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }]
    }
    const second = projectGroupedQuestion(questions, draft, PROMPT_KEY)!

    const result = advanceGroupedQuestion({
      // Multi-select joins its selected option tokens the way the card does.
      response: formatQuestionAnswer(second, ['us-east', 'eu-west']),
      questions,
      draft,
      promptKey: PROMPT_KEY
    })

    expect(result?.kind).toBe('submit')
    expect(
      decodeAgentSessionQuestionAnswers(result?.kind === 'submit' ? result.optionId : '')
    ).toEqual([
      { questionId: 'q1', optionIds: ['q1:choice-1'] },
      { questionId: 'q2', optionIds: ['q2:choice-1', 'q2:choice-2'] }
    ])
  })

  it('carries a free-text answer as `other` for the question it was typed against', () => {
    const questions = [question()]
    const only = projectGroupedQuestion(questions, null, PROMPT_KEY)!

    const result = advanceGroupedQuestion({
      response: formatQuestionFreeTextAnswer(only, '  DuckDB  '),
      questions,
      draft: null,
      promptKey: PROMPT_KEY
    })

    expect(
      decodeAgentSessionQuestionAnswers(result?.kind === 'submit' ? result.optionId : '')
    ).toEqual([{ questionId: 'q1', optionIds: [], other: 'DuckDB' }])
  })

  it('keeps selected options and other text for grouped multi-select answers', () => {
    const questions = [SECOND]
    const only = projectGroupedQuestion(questions, null, PROMPT_KEY)!

    const result = advanceGroupedQuestion({
      response: `${tapOption(only, 0)}, ${formatQuestionFreeTextAnswer(only, 'ap-south')}`,
      questions,
      draft: null,
      promptKey: PROMPT_KEY
    })

    expect(
      decodeAgentSessionQuestionAnswers(result?.kind === 'submit' ? result.optionId : '')
    ).toEqual([{ questionId: 'q2', optionIds: ['q2:choice-1'], other: 'ap-south' }])
  })

  it('gives each step a distinct card key so a selection cannot carry into the next question', () => {
    // The view keys MobileNativeChatQuestion by this value; an identical key would reuse the
    // mounted card and submit step 1's checkboxes as step 2's answer. Claude can legitimately ask
    // the SAME text twice in one group (once per file, say), so identical wording must still key
    // apart on the question id and step counter.
    const questions = [
      question({ id: 'q1', question: 'Approve?' }),
      question({ id: 'q2', question: 'Approve?' })
    ]
    const first = projectGroupedQuestion(questions, null, PROMPT_KEY)!
    const second = projectGroupedQuestion(
      questions,
      { promptKey: PROMPT_KEY, answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }] },
      PROMPT_KEY
    )!

    expect(first.question).toBe('Approve? (1 of 2)')
    expect(second.question).toBe('Approve? (2 of 2)')
    expect(mobileChatQuestionKey(first)).not.toBe(mobileChatQuestionKey(second))
  })

  it('discards a draft collected against a superseded prompt revision', () => {
    const questions = [question(), SECOND]
    const stale: GroupedQuestionDraft = {
      promptKey: groupedQuestionPromptKey('item-1', 2),
      answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }]
    }

    expect(projectGroupedQuestion(questions, stale, PROMPT_KEY)).toMatchObject({
      question: 'Which database? (1 of 2)'
    })
  })

  it('refuses a response that does not answer the current step', () => {
    const questions = [question(), SECOND]

    expect(
      advanceGroupedQuestion({
        response: 'Postgres',
        questions,
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })

  it('refuses an option token rendered for a superseded prompt revision', () => {
    const stale = projectGroupedQuestion([question()], null, groupedQuestionPromptKey('item-1', 2))!

    expect(
      advanceGroupedQuestion({
        response: tapOption(stale, 0),
        questions: [question()],
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })

  it('refuses free text rendered for a superseded prompt revision', () => {
    const stale = projectGroupedQuestion([question()], null, groupedQuestionPromptKey('item-1', 2))!

    expect(
      advanceGroupedQuestion({
        response: formatQuestionFreeTextAnswer(stale, 'stale answer'),
        questions: [question()],
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })

  it('rejects a multi-select response when one selected token is malformed', () => {
    const questions = [SECOND]
    const only = projectGroupedQuestion(questions, null, PROMPT_KEY)!

    expect(
      advanceGroupedQuestion({
        response: `${tapOption(only, 0)}, not-a-grouped-token`,
        questions,
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })

  it('rejects a multi-select response when one selected token belongs to another prompt', () => {
    const questions = [SECOND]
    const current = projectGroupedQuestion(questions, null, PROMPT_KEY)!
    const stale = projectGroupedQuestion(questions, null, groupedQuestionPromptKey('item-1', 2))!

    expect(
      advanceGroupedQuestion({
        response: `${tapOption(current, 0)}, ${tapOption(stale, 1)}`,
        questions,
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })

  it('refuses an empty multi-select rather than sending a group the host would reject', () => {
    const questions = [SECOND]
    const only = projectGroupedQuestion(questions, null, PROMPT_KEY)!

    expect(
      advanceGroupedQuestion({
        response: formatQuestionAnswer(only, []),
        questions,
        draft: null,
        promptKey: PROMPT_KEY
      })
    ).toBeNull()
  })
})
