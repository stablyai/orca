import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('./preset-registry', () => ({
  fetchPresetRegistry: vi.fn()
}))

import { fetchPresetRegistry } from './preset-registry'
import {
  getBedrockDefaults,
  getDefaultBaseUrl,
  getDefaultModelMapping,
  getVertexDefaults,
  resolveCompatDefaults
} from './model-defaults'

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

describe('getBedrockDefaults', () => {
  it('returns unprefixed Bedrock model ids', () => {
    expect(getBedrockDefaults()).toEqual({
      opus: 'anthropic.claude-opus-4-7',
      sonnet: 'anthropic.claude-sonnet-4-6',
      haiku: 'anthropic.claude-haiku-4-5-20251001-v1:0'
    })
  })
})

describe('getVertexDefaults', () => {
  it('returns Vertex model ids', () => {
    expect(getVertexDefaults()).toEqual({
      opus: 'claude-opus-4-7',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5@20251001'
    })
  })
})

describe('resolveCompatDefaults — registry overrides', () => {
  beforeEach(() => {
    vi.mocked(fetchPresetRegistry).mockReset()
  })

  it('uses fresh registry override when present', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValue({
      version: 1,
      presets: { zai: { opus: 'glm-7.0', sonnet: 'glm-7.0', haiku: 'glm-air-2' } }
    })
    const d = await resolveCompatDefaults('zai')
    expect(d.opus).toBe('glm-7.0')
    expect(d.sonnet).toBe('glm-7.0')
    expect(d.haiku).toBe('glm-air-2')
  })

  it('falls back to baked defaults when registry returns null', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValue(null)
    const d = await resolveCompatDefaults('zai')
    expect(d.opus).toBe('glm-5.1') // baked
    expect(d.sonnet).toBe('glm-5.1')
    expect(d.haiku).toBe('glm-4.5-air')
  })

  it('falls back to baked when preset missing from registry', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValue({ version: 1, presets: {} })
    const d = await resolveCompatDefaults('zai')
    expect(d.opus).toBe('glm-5.1')
  })

  it('partial override: baked fills in missing tiers', async () => {
    vi.mocked(fetchPresetRegistry).mockResolvedValue({
      version: 1,
      presets: { kimi: { opus: 'kimi-k3.0' } }
    })
    const d = await resolveCompatDefaults('kimi')
    expect(d.opus).toBe('kimi-k3.0') // override
    expect(d.sonnet).toBe('kimi-k2.6') // baked
    expect(d.haiku).toBe('kimi-k2.6') // baked
  })

  it('falls back to baked when registry fetch throws', async () => {
    vi.mocked(fetchPresetRegistry).mockRejectedValue(new Error('boom'))
    const d = await resolveCompatDefaults('zai')
    expect(d.opus).toBe('glm-5.1')
  })
})
