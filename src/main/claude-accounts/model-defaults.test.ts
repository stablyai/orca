import { describe, expect, it } from 'vitest'
import { getDefaultModelMapping, getDefaultBaseUrl } from './model-defaults'

describe('getDefaultModelMapping', () => {
  it('returns Anthropic IDs for anthropic-api-key', () => {
    const m = getDefaultModelMapping({ authMethod: 'anthropic-api-key' })
    expect(m.opus).toBe('claude-opus-4-7')
    expect(m.sonnet).toBe('claude-sonnet-4-6')
    expect(m.haiku).toBe('claude-haiku-4-5-20251001')
  })

  it('returns GLM-5.1 / GLM-4.5-air for z.ai preset', () => {
    const m = getDefaultModelMapping({
      authMethod: 'anthropic-compat',
      baseUrl: 'https://api.z.ai/api/anthropic',
      preset: 'zai'
    })
    expect(m.opus).toBe('glm-5.1')
    expect(m.sonnet).toBe('glm-5.1')
    expect(m.haiku).toBe('glm-4.5-air')
  })

  it('returns kimi-k2.6 across all tiers for kimi preset', () => {
    const m = getDefaultModelMapping({
      authMethod: 'anthropic-compat',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      preset: 'kimi'
    })
    expect(m.opus).toBe('kimi-k2.6')
    expect(m.sonnet).toBe('kimi-k2.6')
    expect(m.haiku).toBe('kimi-k2.6')
  })

  it('returns MiniMax-M2.7 / -highspeed for minimax preset', () => {
    const m = getDefaultModelMapping({
      authMethod: 'anthropic-compat',
      baseUrl: 'https://api.minimax.io/anthropic',
      preset: 'minimax'
    })
    expect(m.opus).toBe('MiniMax-M2.7')
    expect(m.sonnet).toBe('MiniMax-M2.7')
    expect(m.haiku).toBe('MiniMax-M2.7-highspeed')
  })

  it('returns empty mapping for custom compat preset (user supplies)', () => {
    const m = getDefaultModelMapping({
      authMethod: 'anthropic-compat',
      baseUrl: 'https://example.com',
      preset: 'custom'
    })
    expect(m).toEqual({})
  })
})

describe('getDefaultModelMapping — azure-foundry (P2)', () => {
  it('returns Anthropic native IDs for azure-foundry', () => {
    const m = getDefaultModelMapping({
      authMethod: 'azure-foundry',
      resource: 'r1',
      useEntraId: false
    })
    expect(m.opus).toBe('claude-opus-4-7')
    expect(m.sonnet).toBe('claude-sonnet-4-6')
    expect(m.haiku).toBe('claude-haiku-4-5-20251001')
  })

  it('treats Entra ID variant identically (still native IDs)', () => {
    const m = getDefaultModelMapping({
      authMethod: 'azure-foundry',
      resource: 'r1',
      useEntraId: true
    })
    expect(m.opus).toBe('claude-opus-4-7')
  })
})

describe('getDefaultBaseUrl', () => {
  it.each([
    ['zai', 'https://api.z.ai/api/anthropic'],
    ['kimi', 'https://api.moonshot.ai/anthropic'],
    ['minimax', 'https://api.minimax.io/anthropic']
  ] as const)('returns baked URL for %s', (preset, url) => {
    expect(getDefaultBaseUrl(preset)).toBe(url)
  })

  it('returns null for custom preset', () => {
    expect(getDefaultBaseUrl('custom')).toBeNull()
  })
})
