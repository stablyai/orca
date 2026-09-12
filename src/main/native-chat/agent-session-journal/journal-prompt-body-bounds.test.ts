import { describe, expect, it } from 'vitest'
import type { AgentJournalQuestionItem } from '../../../shared/agent-session-journal-types'
import {
  cancelledJournalPromptBody,
  MAX_CANCELLED_JOURNAL_PROMPT_BODY_BYTES,
  MAX_JOURNAL_GROUPED_PROMPT_OPTIONS,
  MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS
} from './journal-prompt-body-bounds'

const PENDING = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

function groupedQuestion(value: string): AgentJournalQuestionItem {
  const options = Array.from({ length: 64 }, (_unused, index) => ({
    id: `${index}-${value}`,
    label: value,
    description: value
  }))
  return {
    kind: 'question',
    question: value,
    options,
    questions: Array.from({ length: 64 }, (_unused, index) => ({
      id: `${index}-${value}`,
      question: value,
      header: value,
      multiSelect: false,
      options,
      freeTextQuestionId: `${index}-${value}`
    })),
    freeTextQuestionId: value,
    resolution: PENDING
  }
}

describe('cancelled journal prompt bounds', () => {
  it('deep-bounds grouped question text, options, and descriptions', () => {
    const body = cancelledJournalPromptBody(groupedQuestion('界'.repeat(8_000)))

    expect(body?.kind).toBe('question')
    if (!body || body.kind !== 'question') {
      throw new Error('question body was not produced')
    }
    expect(body.questions).toHaveLength(MAX_JOURNAL_GROUPED_PROMPT_QUESTIONS)
    expect(
      body.questions?.every(
        (question) => question.options.length === MAX_JOURNAL_GROUPED_PROMPT_OPTIONS
      )
    ).toBe(true)
    expect(body.questions?.[0]?.options[0]?.description).toContain('output truncated')
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(
      MAX_CANCELLED_JOURNAL_PROMPT_BODY_BYTES
    )
  })

  it('falls back to a compact terminal card when JSON escaping exhausts the body budget', () => {
    const body = cancelledJournalPromptBody(groupedQuestion('\u0000'.repeat(8_000)))

    expect(body).toMatchObject({
      kind: 'question',
      options: [],
      resolution: { state: 'cancelled' }
    })
    expect(body?.kind === 'question' && body.questions).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThanOrEqual(
      MAX_CANCELLED_JOURNAL_PROMPT_BODY_BYTES
    )
  })
})
