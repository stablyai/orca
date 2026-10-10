import { describe, expect, it } from 'vitest'
import {
  speechProviderKeyTestSchema,
  speechProvidersStateSchema
} from './speech-provider-reply-schema'
import { dictationChunkReplySchema } from './dictation-reply-schema'

const provider = (overrides: Record<string, unknown> = {}) => ({
  id: 'soniox',
  kind: 'cloud',
  label: 'Soniox',
  description: 'Real-time',
  keyConfigured: true,
  keyHint: '…a1b2',
  keyUrl: 'https://console.soniox.com/',
  keyPlaceholder: 'Soniox API key',
  models: [{ id: 'soniox-stt-rt-v5', label: 'Soniox v5', realtime: true, status: 'ready' }],
  ...overrides
})

const state = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  selectedModelId: 'soniox-stt-rt-v5',
  dictationMode: 'toggle',
  language: 'auto',
  providers: [provider()],
  ...overrides
})

describe('speech providers state schema', () => {
  it('reads the cabinet the host sends', () => {
    const parsed = speechProvidersStateSchema.parse(state())
    expect(parsed.language).toBe('auto')
    expect(parsed.providers[0]?.keyHint).toBe('…a1b2')
    expect(parsed.providers[0]?.models[0]?.realtime).toBe(true)
  })

  it('keeps a provider a newer desktop added, with an unknown kind degraded to absent', () => {
    const parsed = speechProvidersStateSchema.parse(
      state({ providers: [provider({ id: 'assemblyai', kind: 'hybrid' })] })
    )
    expect(parsed.providers[0]?.id).toBe('assemblyai')
    expect(parsed.providers[0]?.kind).toBeUndefined()
  })

  it('drops rows it cannot address and salvages unreadable decoration', () => {
    const parsed = speechProvidersStateSchema.parse(
      state({
        providers: [
          provider({ models: [{ label: 'no id' }, { id: 'm', status: 'verifying', realtime: 1 }] }),
          { label: 'no id' }
        ]
      })
    )
    expect(parsed.providers).toHaveLength(1)
    expect(parsed.providers[0]?.models).toEqual([
      { id: 'm', status: undefined, realtime: undefined }
    ])
  })

  it('requires the provider list the screens map', () => {
    const { providers: _providers, ...withoutProviders } = state()
    expect(speechProvidersStateSchema.safeParse(withoutProviders).success).toBe(false)
  })

  it('requires the verdict of a key test', () => {
    expect(speechProviderKeyTestSchema.safeParse({ message: null }).success).toBe(false)
    expect(speechProviderKeyTestSchema.parse({ ok: false, message: 'Rejected (401).' })).toEqual({
      ok: false,
      message: 'Rejected (401).'
    })
  })
})

describe('dictation chunk reply schema', () => {
  it('reads the live caption a new host attaches', () => {
    expect(
      dictationChunkReplySchema.parse({ dictationId: 'd', caption: { text: 'hi', revision: 2 } })
        .caption
    ).toEqual({ text: 'hi', revision: 2 })
  })

  it('accepts an old host acknowledgement without a caption', () => {
    expect(dictationChunkReplySchema.parse({ received: true }).caption).toBeUndefined()
  })

  it('never fails the chunk over an unreadable caption or body', () => {
    expect(dictationChunkReplySchema.parse({ caption: { text: 3 } }).caption).toBeUndefined()
    expect(dictationChunkReplySchema.parse(null).caption).toBeUndefined()
    expect(dictationChunkReplySchema.parse(true).caption).toBeUndefined()
  })
})
