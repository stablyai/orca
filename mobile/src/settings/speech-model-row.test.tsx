import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpeechModelRow } from './speech-model-row'
import { voiceCabinetStyles } from './voice-cabinet-styles'
import {
  speechProvidersStateSchema,
  type MobileSpeechProviderModel
} from '../dictation/speech-provider-reply-schema'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  AudioLines: 'Icon',
  Check: 'Icon',
  Download: 'Icon',
  KeyRound: 'Icon',
  Trash2: 'Icon'
}))

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})

function model(status: MobileSpeechProviderModel['status']): MobileSpeechProviderModel {
  return {
    id: 'm',
    label: 'Model',
    status,
    description: undefined,
    realtime: false,
    languages: undefined,
    sizeBytes: null,
    recommended: false,
    progress: null
  }
}

function renderRow(
  variant: 'picker' | 'manage',
  status: MobileSpeechProviderModel['status'],
  options: {
    local?: boolean
    readOnly?: boolean
    onSelect?: () => void
    model?: Partial<MobileSpeechProviderModel>
  } = {}
) {
  act(() => {
    renderer = create(
      createElement(SpeechModelRow, {
        model: { ...model(status), ...options.model },
        local: options.local ?? false,
        selected: false,
        busy: null,
        locked: false,
        readOnly: options.readOnly,
        variant,
        onSelect: options.onSelect ?? vi.fn(),
        onDownload: vi.fn(),
        onDelete: vi.fn()
      })
    )
  })
  return renderer.root.findByProps({ testID: 'speech-model-m' })
}

describe('SpeechModelRow accessibility', () => {
  it('renders manage rows as a plain View so nested buttons stay reachable', () => {
    expect(renderRow('manage', 'ready').type).toBe('View')
  })

  it('leaves the key prompt to the provider instead of each cloud model row', () => {
    const row = renderRow('picker', 'not-downloaded')
    expect(row.props.accessible).toBe(false)
    expect(row.findAllByProps({ accessibilityLabel: 'Add API key for Model' })).toHaveLength(0)
  })

  it('keeps a usable picker row as one selectable radio', () => {
    const row = renderRow('picker', 'ready')
    expect(row.props.accessible).toBe(true)
    expect(row.props.accessibilityRole).toBe('radio')
  })
})

describe('SpeechModelRow layout', () => {
  function touchHeight(node: ReactTestInstance): number {
    const { style, hitSlop } = node.props
    const resolved: unknown = typeof style === 'function' ? style({ pressed: false }) : style
    const flat: { height?: number; minHeight?: number }[] = Array.isArray(resolved)
      ? resolved
      : [resolved]
    const base = Math.max(...flat.map((entry) => entry?.height ?? entry?.minHeight ?? 0))
    return base + (hitSlop?.top ?? 0) + (hitSlop?.bottom ?? 0)
  }

  it('gives the compact Use, Delete and Download buttons a 44pt touch target', () => {
    const row = renderRow('manage', 'ready', { local: true })
    expect(
      touchHeight(row.findByProps({ accessibilityLabel: 'Use Model' }))
    ).toBeGreaterThanOrEqual(44)
    expect(
      touchHeight(row.findByProps({ accessibilityLabel: 'Delete Model' }))
    ).toBeGreaterThanOrEqual(44)
    const download = renderRow('manage', 'not-downloaded', { local: true })
    expect(
      touchHeight(download.findByProps({ accessibilityLabel: 'Download Model' }))
    ).toBeGreaterThanOrEqual(44)
  })

  it('gives the Delete and Download icon buttons a 44pt touch target across too', () => {
    function touchWidth(node: ReactTestInstance): number {
      const { style, hitSlop } = node.props
      const resolved: unknown = typeof style === 'function' ? style({ pressed: false }) : style
      const flat: { width?: number }[] = Array.isArray(resolved) ? resolved : [resolved]
      const base = Math.max(...flat.map((entry) => entry?.width ?? 0))
      return base + (hitSlop?.left ?? 0) + (hitSlop?.right ?? 0)
    }
    const row = renderRow('manage', 'ready', { local: true })
    expect(
      touchWidth(row.findByProps({ accessibilityLabel: 'Delete Model' }))
    ).toBeGreaterThanOrEqual(44)
    const download = renderRow('manage', 'not-downloaded', { local: true })
    expect(
      touchWidth(download.findByProps({ accessibilityLabel: 'Download Model' }))
    ).toBeGreaterThanOrEqual(44)
  })

  it('caps Dynamic Type on the LIVE and Recommended badges', () => {
    const row = renderRow('manage', 'ready', { model: { realtime: true, recommended: true } })
    for (const label of ['LIVE', 'Recommended']) {
      expect(row.findByProps({ children: label }).props.maxFontSizeMultiplier).toBe(1.5)
    }
  })
})

describe('SpeechModelRow action roles', () => {
  it('announces Use, Delete and Download as buttons', () => {
    const row = renderRow('manage', 'ready', { local: true })
    for (const label of ['Use Model', 'Delete Model']) {
      expect(row.findByProps({ accessibilityLabel: label }).props.accessibilityRole).toBe('button')
    }
    const download = renderRow('manage', 'not-downloaded', { local: true })
    expect(
      download.findByProps({ accessibilityLabel: 'Download Model' }).props.accessibilityRole
    ).toBe('button')
  })
})

describe('SpeechModelRow unknown status', () => {
  it('offers no Download for a status this build has not heard of', () => {
    const parsed = speechProvidersStateSchema.parse({
      providers: [{ id: 'local', models: [{ id: 'm', label: 'Model', status: 'verifying' }] }]
    })
    const status = parsed.providers[0]?.models[0]?.status
    expect(status).toBeUndefined()
    const row = renderRow('manage', status, { local: true })
    expect(row.findAllByProps({ accessibilityLabel: 'Download Model' })).toHaveLength(0)
    const failed = renderRow('manage', 'error', { local: true })
    expect(failed.findAllByProps({ accessibilityLabel: 'Download Model' })).toHaveLength(1)
  })
})

describe('SpeechModelRow read-only provider', () => {
  it('never selects a ready model of a provider kind this build does not know', () => {
    const onSelect = vi.fn()
    const picker = renderRow('picker', 'ready', { readOnly: true, onSelect })
    expect(picker.props.disabled).toBe(true)
    const manage = renderRow('manage', 'ready', { readOnly: true, onSelect })
    expect(manage.findAllByProps({ accessibilityLabel: 'Use Model' })).toHaveLength(0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('dims a read-only manage row and drops its empty actions wrapper', () => {
    const dimmed = voiceCabinetStyles.modelRowDimmed
    const manage = renderRow('manage', 'ready', { readOnly: true })
    expect(manage.props.style).toContain(dimmed)
    expect(manage.findAllByProps({ style: voiceCabinetStyles.rowActions })).toHaveLength(0)

    const writable = renderRow('manage', 'ready')
    expect(writable.props.style).not.toContain(dimmed)
    expect(writable.findAllByProps({ style: voiceCabinetStyles.rowActions })).toHaveLength(1)
  })
})
