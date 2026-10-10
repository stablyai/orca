import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileDictationCaptionStrip } from './MobileDictationCaptionStrip'
import { MobileTerminalLiveInputStatus } from './MobileTerminalLiveInputStatus'
import { MobileDictationCaptionStore } from '../hooks/mobile-dictation-caption-store'

const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('react-native', () => {
  class AnimatedValue {
    setValue(): void {}
  }
  const animation = { start() {}, stop() {} }
  return {
    View: 'View',
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
    Platform: platform,
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Animated: {
      Value: AnimatedValue,
      View: 'AnimatedView',
      loop: () => animation,
      sequence: () => animation,
      timing: () => animation
    }
  }
})

let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
  platform.OS = 'ios'
})

function render(element: ReturnType<typeof createElement>): string {
  act(() => {
    renderer = create(element)
  })
  return JSON.stringify(renderer.toJSON())
}

const idle = { isRecording: false, isProcessing: false, isStarting: false }

function captionStore(text: string): MobileDictationCaptionStore {
  const store = new MobileDictationCaptionStore()
  store.set(text)
  return store
}

describe('MobileDictationCaptionStrip', () => {
  it('reserves two scaled caption lines and caps the caption Dynamic Type', () => {
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true, captionStore: captionStore('hello there') },
        variant: 'dock'
      })
    )
    const strip = renderer.root.findByProps({ testID: 'dictation-caption-strip' })
    expect(strip.props.style).toEqual(expect.arrayContaining([{ minHeight: 54 }]))
    const caption = renderer.root.findByProps({ children: 'hello there' })
    expect(caption.props.maxFontSizeMultiplier).toBe(1.5)
  })

  it('renders nothing while the mic is closed', () => {
    expect(
      render(createElement(MobileDictationCaptionStrip, { dictation: idle, variant: 'dock' }))
    ).toBe('null')
  })

  it('says it is listening until the first caption arrives', () => {
    const json = render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true },
        variant: 'card'
      })
    )
    expect(json).toContain('Listening…')
    expect(json).toContain('AnimatedView')
  })

  it('shows the newest words, head-ellipsized over two lines on iOS', () => {
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: {
          ...idle,
          isRecording: true,
          captionStore: captionStore('make the captions follow')
        },
        variant: 'dock'
      })
    )
    const caption = renderer.root.findByProps({ children: 'make the captions follow' })
    expect(caption.props.numberOfLines).toBe(2)
    expect(caption.props.ellipsizeMode).toBe('head')
  })

  it('cuts old words in JS on Android, where multi-line head ellipsis is ignored', () => {
    platform.OS = 'android'
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`)
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true, captionStore: captionStore(words.join(' ')) },
        variant: 'dock'
      })
    )
    const caption = renderer.root.findByProps({ numberOfLines: 2 })
    act(() => caption.props.onLayout({ nativeEvent: { layout: { width: 300 } } }))
    const shown = String(renderer.root.findByProps({ numberOfLines: 2 }).props.children)
    expect(renderer.root.findByProps({ numberOfLines: 2 }).props.ellipsizeMode).toBe('tail')
    expect(shown.startsWith('…')).toBe(true)
    expect(shown.endsWith('word59')).toBe(true)
    expect(shown.length).toBeLessThanOrEqual(70)
  })

  it('reserves two caption lines so the strip height stays put', () => {
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true },
        variant: 'dock'
      })
    )
    const strip = renderer.root.findByProps({ testID: 'dictation-caption-strip' })
    const styles: { minHeight?: number }[] = strip.props.style
    expect(styles.some((style) => (style?.minHeight ?? 0) >= 38)).toBe(true)
  })

  it('drops the caption for a transcribing note once the user stops', () => {
    const json = render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isProcessing: true, captionStore: captionStore('stale words') },
        variant: 'dock'
      })
    )
    expect(json).toContain('Transcribing…')
    expect(json).not.toContain('stale words')
  })
  it('repaints only from the caption store while recording', () => {
    const store = new MobileDictationCaptionStore()
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true, captionStore: store },
        variant: 'dock'
      })
    )
    expect(JSON.stringify(renderer.toJSON())).toContain('Listening…')
    act(() => store.set('fresh words'))
    expect(JSON.stringify(renderer.toJSON())).toContain('fresh words')
  })

  it('falls back to Listening… when the caption is emptied mid-recording', () => {
    const store = captionStore('maybe')
    render(
      createElement(MobileDictationCaptionStrip, {
        dictation: { ...idle, isRecording: true, captionStore: store },
        variant: 'card'
      })
    )
    expect(JSON.stringify(renderer.toJSON())).toContain('maybe')
    act(() => store.set(''))
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain('Listening…')
    expect(json).not.toContain('maybe')
  })
})

describe('MobileTerminalLiveInputStatus caption', () => {
  it('replaces the stop hint with the live caption while recording', () => {
    const props = { isAttaching: false, liveInputText: '' }
    expect(
      render(
        createElement(MobileTerminalLiveInputStatus, {
          ...props,
          dictation: { ...idle, isRecording: true, captionStore: captionStore('git status') }
        })
      )
    ).toContain('git status')
    expect(
      render(
        createElement(MobileTerminalLiveInputStatus, {
          ...props,
          dictation: { ...idle, isRecording: true }
        })
      )
    ).toContain('Tap mic to stop')
  })
})
