import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposerMic } from './MobileNativeChatComposerMic'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'
import { createMobileDictationMeter } from '../../../hooks/mobile-dictation-meter'
import { MobileDictationMeterContext } from '../../mobile-dictation-meter-context'

const pressables = vi.hoisted(() => ({ unmounted: 0 }))

vi.mock('react-native', async () => {
  const { createElement: h, useEffect } = await import('react')
  return {
    ...(await import('../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
    ActivityIndicator: 'ActivityIndicator',
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
    Pressable: (props: { children?: unknown }) => {
      useEffect(
        () => () => {
          pressables.unmounted += 1
        },
        []
      )
      return h('Pressable', props)
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({ Mic: 'Mic', Square: 'Square' }))

describe('MobileNativeChatComposerMic', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('adds the meter beside the mic without remounting it under a held press', () => {
    const meter = createMobileDictationMeter()
    const render = (micStarting: boolean) =>
      createElement(
        MobileDictationMeterContext.Provider,
        { value: meter },
        createElement(MobileNativeChatComposerMic, {
          onMicPress: vi.fn(),
          micActive: true,
          micStarting,
          dictationMode: 'hold',
          disabled: false
        })
      )
    act(() => {
      renderer = create(render(true))
    })
    const unmountedBefore = pressables.unmounted
    act(() => renderer!.update(render(false)))
    expect(pressables.unmounted).toBe(unmountedBefore)
    expect(findAllByHostType(renderer!.root, 'Text').map((text) => text.props.children)).toEqual([
      '0:00'
    ])
  })
})
