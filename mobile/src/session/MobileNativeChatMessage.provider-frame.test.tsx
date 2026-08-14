import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'

vi.mock('react-native', () => ({
  Image: 'Image',
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'MobileMarkdown' }))
vi.mock('./mobile-native-chat-message-styles', () => ({
  TEXT_SIZE: 17,
  styles: new Proxy({}, { get: () => ({}) })
}))

describe('MobileNativeChatMessage provider frame', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('expands a one-line provider-kind row to its bounded payload', () => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatMessage, {
          message: {
            id: 'frame-1',
            role: 'system',
            source: 'transcript',
            timestamp: 1,
            blocks: [
              {
                type: 'text',
                text: 'codex · notification:new/event',
                providerFrame: {
                  provider: 'codex',
                  kind: 'notification:new/event',
                  payload: {
                    head: '{"future":true}',
                    byteLength: 15,
                    digest: 'digest',
                    truncated: false
                  }
                }
              }
            ]
          }
        })
      )
    })

    const labels = renderer!.root.findAllByType('Text').flatMap((node) => node.children)
    expect(labels).toContain('codex')
    expect(labels).toContain('notification:new/event')
    expect(labels).not.toContain('{"future":true}')

    act(() => renderer!.root.findAllByType('Pressable')[0]!.props.onPress())

    expect(renderer!.root.findAllByType('Text').flatMap((node) => node.children)).toContain(
      '{"future":true}'
    )
  })
})
