import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Pressable } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import { dictationSetupSchema } from '../dictation/dictation-reply-schema'
import { VoiceModelList } from './VoiceModelList'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Icon', Download: 'Icon', Trash2: 'Icon' }))

describe('cloud speech model rows', () => {
  it.each(['ready', 'not-downloaded'] as const)(
    'shows OpenRouter %s credentials without offering local model actions',
    async (status) => {
      let renderer: ReactTestRenderer | undefined
      try {
        await act(async () => {
          renderer = create(
            createElement(VoiceModelList, {
              setup: dictationSetupSchema.parse({
                enabled: true,
                models: [{ id: 'openrouter-mai-transcribe-2', provider: 'openrouter', status }]
              }),
              disabled: false,
              busyAction: null,
              onUseModel: vi.fn(),
              onDownload: vi.fn(),
              onDelete: vi.fn()
            })
          )
        })
        const content = JSON.stringify(renderer?.toJSON())
        expect(content).toContain('OpenRouter API')
        expect(content).toContain(status === 'ready' ? 'API key set' : 'Set up on desktop')
        expect(renderer?.root.findAllByType(Pressable)).toHaveLength(0)
      } finally {
        act(() => renderer?.unmount())
      }
    }
  )
})
