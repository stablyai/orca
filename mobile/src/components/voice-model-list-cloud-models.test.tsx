import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    ActivityIndicator: host('ActivityIndicator'),
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})
vi.mock('lucide-react-native', () => ({
  Check: () => null,
  Download: () => null,
  Trash2: () => null
}))

import { VoiceModelList } from './VoiceModelList'
import {
  CLOUD_MODEL_NEEDS_KEY,
  type MobileSpeechModel,
  type MobileSpeechSetup
} from '../dictation/mobile-dictation-setup'

function cloud(id: string, status: MobileSpeechModel['status']): MobileSpeechModel {
  return { id, label: id, provider: 'openai', sizeBytes: null, status, progress: null }
}

// #31174: a cloud-only host (Windows or a managed SSH server) lists only OpenAI rows.
describe('VoiceModelList cloud models', () => {
  let renderer: ReactTestRenderer | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(setup: MobileSpeechSetup, onUseModel = vi.fn()) {
    act(() => {
      renderer = create(
        createElement(VoiceModelList, {
          setup,
          disabled: false,
          busyAction: null,
          onUseModel,
          onDownload: vi.fn(),
          onDelete: vi.fn()
        })
      )
    })
    const root = renderer!.root
    const texts = root.findAll((n) => String(n.type) === 'Text').map((n) => n.props.children)
    const pressables = root.findAll((n) => String(n.type) === 'Pressable')
    return { texts, pressables, onUseModel }
  }

  it('offers a ready cloud model to pick, with nothing to delete', () => {
    const ready = cloud('openai-gpt-4o-mini-transcribe', 'ready')
    const { texts, pressables, onUseModel } = render({
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: [ready]
    })
    expect(texts).toContain('Use')
    expect(pressables).toHaveLength(1)
    expect(pressables[0].props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: `Use ${ready.label}`,
      accessibilityState: { disabled: false }
    })
    act(() => pressables[0].props.onPress())
    expect(onUseModel).toHaveBeenCalledWith(ready)
  })

  it('marks the cloud model in use once picked', () => {
    const ready = cloud('openai-gpt-4o-mini-transcribe', 'ready')
    const { texts, pressables } = render({
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: ready.id,
      models: [ready]
    })
    expect(texts).toContain('In use')
    expect(pressables).toHaveLength(0)
  })

  it('says where to add the key when the cloud model is not ready', () => {
    const { texts, pressables } = render({
      enabled: true,
      dictationMode: 'toggle',
      selectedModelId: '',
      models: [cloud('openai-gpt-4o-transcribe', 'not-downloaded')]
    })
    expect(texts).toContain(CLOUD_MODEL_NEEDS_KEY)
    expect(pressables).toHaveLength(0)
  })
})
