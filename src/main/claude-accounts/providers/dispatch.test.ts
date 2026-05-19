import { describe, expect, it } from 'vitest'
import { handlerFor } from './dispatch'

describe('handlerFor', () => {
  it('returns OAuth handler for subscription-oauth', () => {
    expect(handlerFor('subscription-oauth').authMethod).toBe('subscription-oauth')
  })

  it('returns Anthropic API key handler', () => {
    expect(handlerFor('anthropic-api-key').authMethod).toBe('anthropic-api-key')
  })

  it('returns Anthropic-compat handler', () => {
    expect(handlerFor('anthropic-compat').authMethod).toBe('anthropic-compat')
  })

  it('throws on unknown authMethod', () => {
    expect(() => handlerFor('unknown')).toThrow(/no provider handler/i)
  })
})
