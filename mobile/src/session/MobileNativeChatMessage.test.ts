import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Clipboard from 'expo-clipboard'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Image: 'Image',
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    Text: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))

import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { mobileNativeChatTextKey } from './use-mobile-native-chat-text-expansion'
import type { MobileNativeChatTextExpansion } from './use-mobile-native-chat-text-expansion'

function userMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'u1', role: 'user', blocks, timestamp: null, source: 'transcript' }
}

function assistantMessage(blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id: 'a1', role: 'assistant', blocks, timestamp: null, source: 'transcript' }
}

describe('MobileNativeChatMessage image-ref rendering', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.mocked(Clipboard.setStringAsync).mockReset().mockResolvedValue()
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(
    message: NativeChatMessage,
    textExpansion?: MobileNativeChatTextExpansion,
    fontScale = 1
  ): ReactTestRenderer {
    const original = console.error
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      if (typeof a[0] === 'string' && a[0].includes('react-test-renderer is deprecated')) {
        return
      }
      original(...a)
    })
    try {
      act(() => {
        renderer = create(
          createElement(MobileNativeChatMessage, { message, textExpansion, fontScale })
        )
      })
    } finally {
      spy.mockRestore()
    }
    return renderer!
  }

  it('renders a loadable preview URI as an image thumbnail', () => {
    const tree = render(userMessage([{ type: 'image-ref', url: 'file:///a.jpg', alt: 'a photo' }]))
    const image = tree.root.findByType('Image' as never)
    expect(image.props.source).toEqual({ uri: 'file:///a.jpg' })
    expect(image.props.accessibilityLabel).toBe('a photo')
  })

  it('prefers the url over the path when both are present', () => {
    const tree = render(
      userMessage([{ type: 'image-ref', url: 'file:///local.jpg', path: '/tmp/host.png' }])
    )
    expect(tree.root.findByType('Image' as never).props.source).toEqual({
      uri: 'file:///local.jpg'
    })
  })

  it('falls back to a text placeholder for a bare host path', () => {
    // A host temp path (e.g. on an SSH host) is not loadable on the device.
    const tree = render(userMessage([{ type: 'image-ref', path: '/tmp/host.png' }]))
    expect(tree.root.findAllByType('Image' as never)).toHaveLength(0)
    const texts = tree.root
      .findAllByType('Text' as never)
      .map((node) => String(node.children.join('')))
    expect(texts.some((text) => text.includes('/tmp/host.png'))).toBe(true)
  })

  it.each([
    ['ordinary prose', `Summary\n\n${'Readable paragraph. '.repeat(300)}`],
    ['fenced code', `\`\`\`ts\n${'const answer = 42\n'.repeat(300)}\`\`\``]
  ])('renders complete %s after lazy expansion', (_label, fullText) => {
    const retrieval = { capability: 'capability-expanded', originalChars: fullText.length }
    const message: NativeChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: `${fullText.slice(0, 4000)}\n… (truncated)`, retrieval }],
      timestamp: null,
      source: 'transcript'
    }
    const key = mobileNativeChatTextKey(message.id, retrieval)
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: { key, text: fullText },
      expandedKey: key,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn().mockResolvedValue(fullText)
    }

    const tree = render(message, textExpansion)

    expect(tree.root.findByType('MobileMarkdown' as never).props.content).toBe(fullText)
    expect(tree.root.findByProps({ accessibilityLabel: 'Show less' })).toBeTruthy()
  })

  it('chunks very long expanded prose into visible native text nodes', () => {
    const fullText = Array.from(
      { length: 3000 },
      (_, index) => `Paragraph ${index}: readable native chat prose.`
    ).join('\n\n')
    const retrieval = { capability: 'capability-long', originalChars: fullText.length }
    const message: NativeChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: `${fullText.slice(0, 4000)}\n… (truncated)`, retrieval }],
      timestamp: null,
      source: 'transcript'
    }
    const key = mobileNativeChatTextKey(message.id, retrieval)
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: { key, text: fullText },
      expandedKey: key,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn().mockResolvedValue(fullText)
    }

    const tree = render(message, textExpansion)
    const chunks = tree.root
      .findAllByType('Text' as never)
      .filter((node) => node.props.selectable === true)
      .map((node) => node.children.join(''))

    expect(fullText.length).toBeGreaterThan(100_000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(fullText)
    expect(tree.root.findAllByType('MobileMarkdown' as never)).toHaveLength(0)
  })

  it('uses the same chunked renderer before and after a very long Markdown expansion', () => {
    const fullText = `# Result\n\n\`\`\`ts\n${'const value = 42\n'.repeat(7000)}\`\`\``
    const preview = `${fullText.slice(0, 4000)}\n… (truncated)`
    const retrieval = { capability: 'capability-markdown', originalChars: fullText.length }
    const message = assistantMessage([{ type: 'text', text: preview, retrieval }])
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: null,
      expandedKey: null,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn().mockResolvedValue(fullText)
    }

    const tree = render(message, textExpansion)
    const previewChunks = tree.root
      .findAllByType('Text' as never)
      .filter((node) => node.props.selectable === true)
      .map((node) => node.children.join(''))

    expect(fullText.length).toBeGreaterThan(100_000)
    expect(previewChunks.join('')).toBe(preview)
    expect(tree.root.findAllByType('MobileMarkdown' as never)).toHaveLength(0)
  })

  it('chunks very long user text and scales its line height with pinch zoom', () => {
    const fullText = 'User prose. '.repeat(10_000)
    const retrieval = { capability: 'capability-user-long', originalChars: fullText.length }
    const message = userMessage([{ type: 'text', text: 'User prose preview', retrieval }])
    const key = mobileNativeChatTextKey(message.id, retrieval)
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: { key, text: fullText },
      expandedKey: key,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn().mockResolvedValue(fullText)
    }

    const chunks = render(message, textExpansion, 1.8)
      .root.findAllByType('Text' as never)
      .filter((node) => node.props.selectable === true)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((node) => node.children.join('')).join('')).toBe(fullText)
    expect(chunks[0].props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ fontSize: 30.6, lineHeight: 41.4 })])
    )
  })

  it('strips the image prompt marker from expanded user text', () => {
    const retrieval = { capability: 'capability-caption', originalChars: 9000 }
    const message = userMessage([{ type: 'text', text: 'caption preview', retrieval }])
    const key = mobileNativeChatTextKey(message.id, retrieval)
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: { key, text: '[Image #1] complete caption' },
      expandedKey: key,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn().mockResolvedValue('[Image #1] complete caption')
    }

    const tree = render(message, textExpansion)
    const text = tree.root
      .findAllByType('Text' as never)
      .map((node) => node.children.join(''))
      .join(' ')

    expect(text).toContain('complete caption')
    expect(text).not.toContain('[Image #1]')
  })

  it('disables all expansion actions while one block is loading', () => {
    const firstRetrieval = { capability: 'capability-first', originalChars: 9000 }
    const secondRetrieval = { capability: 'capability-second', originalChars: 8000 }
    const message: NativeChatMessage = {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'first preview', retrieval: firstRetrieval },
        { type: 'text', text: 'second preview', retrieval: secondRetrieval }
      ],
      timestamp: null,
      source: 'transcript'
    }
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: null,
      expandedKey: null,
      loadingKey: mobileNativeChatTextKey(message.id, firstRetrieval),
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy: vi.fn()
    }

    const tree = render(message, textExpansion)
    const actions = tree.root.findAll((node) => node.props.accessibilityState?.disabled === true)

    expect(actions).toHaveLength(2)
    expect(actions.every((action) => action.props.disabled === true)).toBe(true)
    expect(
      tree.root.findByProps({ accessibilityLabel: 'Loading full response…' }).props
        .accessibilityState
    ).toMatchObject({ busy: true })
  })

  it('recovers every clipped prose block before copying the exact message', async () => {
    const first = { capability: 'capability-copy-first', originalChars: 5000 }
    const second = { capability: 'capability-copy-second', originalChars: 6000 }
    const loadForCopy = vi
      .fn()
      .mockResolvedValueOnce('complete first')
      .mockResolvedValueOnce('complete second')
    const textExpansion: MobileNativeChatTextExpansion = {
      cached: null,
      expandedKey: null,
      loadingKey: null,
      errorKey: null,
      toggle: vi.fn(),
      loadForCopy
    }
    const tree = render(
      assistantMessage([
        { type: 'text', text: 'first preview', retrieval: first },
        { type: 'text', text: 'second preview', retrieval: second }
      ]),
      textExpansion
    )

    await act(async () =>
      tree.root.findByProps({ accessibilityLabel: 'Copy message' }).props.onPress()
    )

    expect(loadForCopy.mock.calls.map((call) => call[1])).toEqual([first, second])
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('complete first\n\ncomplete second')
  })

  it('reports clipboard rejection without showing copied success', async () => {
    vi.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(new Error('clipboard full'))
    const tree = render(assistantMessage([{ type: 'text', text: 'complete' }]))

    await act(async () =>
      tree.root.findByProps({ accessibilityLabel: 'Copy message' }).props.onPress()
    )

    expect(tree.root.findByProps({ accessibilityLabel: 'Retry copying message' })).toBeTruthy()
    expect(tree.root.findByProps({ accessibilityRole: 'alert' })).toBeTruthy()
    expect(
      tree.root.findAllByType('Text' as never).map((node) => node.children.join(''))
    ).toContain('Copy failed')
  })
})
