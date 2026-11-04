import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseOpenCodeModelListing } from './opencode-model-catalog-listing'

describe('OpenCode verbose model listing', () => {
  it('keeps the facts a listing states for the picker card, and only those', () => {
    const stdout = readFileSync(
      new URL('../../acp/fixtures/opencode-v1-model-listing.txt', import.meta.url),
      'utf8'
    )
    const partial = [
      'openrouter/vision',
      '{',
      '  "providerID": "openrouter",',
      '  "cost": { "input": 0.5 },',
      '  "limit": { "context": 0, "output": 8192 },',
      '  "capabilities": { "input": { "text": true, "image": true, "pdf": true } }',
      '}'
    ].join('\n')
    const models = parseOpenCodeModelListing(`${stdout}\n${partial}\n`)
    const recorded = models.find(({ id }) => id === 'opencode/beam-free')
    const listed = models.find(({ id }) => id === 'openrouter/vision')
    expect(recorded?.details).toEqual({
      provider: 'opencode',
      inputs: ['text'],
      reasoning: true,
      contextWindowTokens: 1_048_576,
      maxOutputTokens: 131_072,
      free: true
    })
    // A half-stated price, an empty window and absent reasoning are unknown, not false.
    expect(listed?.details).toEqual({
      provider: 'openrouter',
      inputs: ['text', 'image', 'pdf'],
      maxOutputTokens: 8192
    })
  })
})
