import { createElement } from 'react'
import { Image, Text, View } from 'react-native'
import { act, create as createRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileRepoIcon } from './MobileRepoIcon'

vi.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Image: 'Image',
  StyleSheet: { create: (s: unknown) => s }
}))

vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Svg: 'Svg',
  Path: 'Path'
}))

vi.mock('../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: vi.fn()
}))

describe('MobileRepoIcon', () => {
  it('renders an Image component for image repoIcon', () => {
    let renderer: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'image', src: 'https://github.com/avatar.png', label: 'Repo' },
          size: 16
        })
      )
    })
    const image = renderer!.root.findByType(Image)
    expect(image.props.source).toEqual({ uri: 'https://github.com/avatar.png' })
    expect(image.props.accessibilityLabel).toBe('Repo')
  })

  it('renders Folder placeholder while loading and reveals image after onLoad', () => {
    let renderer: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'image', src: 'https://github.com/avatar.png', label: 'Repo' },
          size: 16
        })
      )
    })
    const image = renderer!.root.findByType(Image)
    expect(image.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ position: 'absolute', opacity: 0 })])
    )

    act(() => {
      image.props.onLoad()
    })
    expect(image.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ width: 16, height: 16 })])
    )
    expect(image.props.style).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ position: 'absolute', opacity: 0 })])
    )
  })

  it('falls back to Folder icon when Image triggers onError', () => {
    let renderer: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'image', src: 'https://github.com/broken.png', label: 'Broken' },
          size: 16
        })
      )
    })
    const image = renderer!.root.findByType(Image)
    act(() => {
      image.props.onError()
    })
    // After error, Image is no longer rendered; Folder icon is rendered in a glyph View
    expect(renderer!.root.findAllByType(Image)).toHaveLength(0)
    expect(renderer!.root.findAllByType(View).length).toBeGreaterThan(0)
  })

  it('resets image failure state when repoIcon src changes', () => {
    let renderer: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'image', src: 'https://github.com/first.png', label: 'First' },
          size: 16
        })
      )
    })
    const image = renderer!.root.findByType(Image)
    act(() => {
      image.props.onError()
    })
    expect(renderer!.root.findAllByType(Image)).toHaveLength(0)

    // Update with new URL
    act(() => {
      renderer.update(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'image', src: 'https://github.com/second.png', label: 'Second' },
          size: 16
        })
      )
    })
    const newImage = renderer!.root.findByType(Image)
    expect(newImage.props.source).toEqual({ uri: 'https://github.com/second.png' })
  })

  it('renders emoji correctly', () => {
    let renderer: ReturnType<typeof createRenderer>
    act(() => {
      renderer = createRenderer(
        createElement(MobileRepoIcon, {
          repoIcon: { type: 'emoji', emoji: '🚀' },
          size: 14
        })
      )
    })
    const text = renderer!.root.findByType(Text)
    expect(text.props.children).toBe('🚀')
  })
})
