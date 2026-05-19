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

  it('returns Azure Foundry handler', () => {
    expect(handlerFor('azure-foundry').authMethod).toBe('azure-foundry')
  })

  it('throws on unknown authMethod', () => {
    expect(() => handlerFor('unknown')).toThrow(/no provider handler/i)
  })
})

describe('handlerFor (P3)', () => {
  it('returns the AWS Bedrock handler for "aws-bedrock"', () => {
    expect(handlerFor('aws-bedrock').authMethod).toBe('aws-bedrock')
  })
  it('returns the Google Vertex handler for "google-vertex"', () => {
    expect(handlerFor('google-vertex').authMethod).toBe('google-vertex')
  })
})
