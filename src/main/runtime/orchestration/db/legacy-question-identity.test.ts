import { describe, expect, it } from 'vitest'
import type { MessageRow } from '../types'
import {
  legacyMessageMatchesQuestion,
  normalizeLegacyQuestionOptions,
  normalizeLegacyQuestionText
} from './legacy-question-identity'

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_1',
    run_id: 'run_1',
    delivery_contract: 'legacy_direct',
    from_handle: 'from',
    to_handle: 'to',
    subject: 'q',
    body: 'Ask this?\r\n',
    type: 'question',
    priority: 'normal',
    thread_id: null,
    payload: '{"options":[" yes ","no"]}',
    read: 0,
    sequence: 1,
    created_at: '2026-01-01 00:00:00',
    delivered_at: null,
    sender_pane_key: null,
    ...overrides
  }
}

describe('legacy-question-identity', () => {
  it('normalizes question text and option arrays', () => {
    expect(normalizeLegacyQuestionText('  a\r\nb  ')).toBe('a\nb')
    expect(normalizeLegacyQuestionOptions([' yes ', 'no'])).toBe('["yes","no"]')
    expect(normalizeLegacyQuestionOptions(['yes', 1])).toBe('[]')
  })

  it('matches a question only when recipient, body, and options agree', () => {
    expect(legacyMessageMatchesQuestion(message(), 'Ask this?', ['yes', 'no'], ['to'])).toBe(true)
    expect(legacyMessageMatchesQuestion(message(), 'Ask this?', ['yes', 'no'], ['other'])).toBe(
      false
    )
    expect(legacyMessageMatchesQuestion(message(), 'Different', ['yes', 'no'], ['to'])).toBe(false)
    expect(
      legacyMessageMatchesQuestion(message({ payload: '{' }), 'Ask this?', ['yes'], ['to'])
    ).toBe(false)
  })
})
