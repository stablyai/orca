import { createElement } from 'react'
import { Linking } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownImage } from './MarkdownImage'

vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: 'Pressable',
  Text: 'Text',
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  Linking: { openURL: vi.fn(() => Promise.resolve()) }
}))

vi.mock('../../theme/mobile-theme', () => ({
  colors: { textPrimary: '#fff', bgRaised: '#222' },
  radii: { row: 6 },
  spacing: { sm: 8 }
}))

// The scheme gate (markdown-link-scheme) is intentionally NOT mocked — the point of these
// tests is that the real allowlist keeps disallowed schemes from ever reaching an <Image>.

function suppressDeprecationWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

function render(uri: string, extra?: { href?: string }): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  const restore = suppressDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(MarkdownImage, { uri, alt: 'shot', base: 14, ...extra }))
    })
  } finally {
    restore()
  }
  if (!renderer) {
    throw new Error('MarkdownImage did not render')
  }
  return renderer
}

describe('MarkdownImage', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    renderer?.unmount()
    renderer = null
    vi.restoreAllMocks()
  })

  it('renders an <Image> for an allowed http(s) scheme', () => {
    renderer = render('https://x.y/a.png')
    expect(renderer.root.findAllByType('Image')).toHaveLength(1)
    expect(renderer.root.findAllByType('Text')).toHaveLength(0)
  })

  it('degrades a disallowed scheme to a non-tappable text link (never an <Image>)', () => {
    renderer = render('data:image/png;base64,AAAA')
    expect(renderer.root.findAllByType('Image')).toHaveLength(0)
    // Not tappable: a disallowed scheme must never reach the OS URL handler.
    expect(renderer.root.findByType('Text').props.onPress).toBeUndefined()
  })

  it('falls back to a text link when the image fails to load', () => {
    renderer = render('https://x.y/broken.png')
    act(() => {
      renderer?.root.findByType('Image').props.onError()
    })
    expect(renderer.root.findAllByType('Image')).toHaveLength(0)
    expect(renderer.root.findAllByType('Text')).toHaveLength(1)
  })

  it('taps a linked image through to its href, not the image url', () => {
    vi.mocked(Linking.openURL).mockClear()
    renderer = render('https://x.y/a.png', { href: 'https://x.y/full' })
    act(() => {
      renderer?.root.findByType('Pressable').props.onPress()
    })
    expect(Linking.openURL).toHaveBeenCalledWith('https://x.y/full')
  })
})
