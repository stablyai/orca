import { describe, expect, it } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE,
  NATIVE_CHAT_VISUAL_SIZE_TYPE
} from '../../../src/shared/native-chat-visual-shell'
import { readMobileNativeChatVisualBridgeMessage } from './mobile-native-chat-visual-bridge'
import { buildMobileNativeChatVisualHostDocument } from './mobile-native-chat-visual-host-document'

const TOKEN = 'f'.repeat(32)
const CHANNEL = 'c'.repeat(32)

function frame(data: Record<string, unknown>, token: string = TOKEN): string {
  return JSON.stringify({ token, kind: 'frame', data: { channel: CHANNEL, ...data } })
}

function read(raw: unknown) {
  return readMobileNativeChatVisualBridgeMessage(raw, TOKEN, CHANNEL)
}

describe('readMobileNativeChatVisualBridgeMessage', () => {
  it('accepts a size report and an http(s) link relayed by the host document', () => {
    expect(read(frame({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, height: 312.4 }))).toEqual({
      kind: 'size',
      height: 312.4
    })
    expect(
      read(frame({ type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, url: 'https://example.com/a?b=c' }))
    ).toEqual({ kind: 'open-link', url: 'https://example.com/a?b=c' })
    expect(read(JSON.stringify({ token: TOKEN, kind: 'escaped' }))).toEqual({ kind: 'escaped' })
  })

  it('drops a message without this frame token or from another channel', () => {
    const size = { type: NATIVE_CHAT_VISUAL_SIZE_TYPE, height: 300 }
    expect(read(frame(size, 'other'))).toBeNull()
    expect(read(JSON.stringify({ kind: 'frame', data: { channel: CHANNEL, ...size } }))).toBeNull()
    expect(read(JSON.stringify({ kind: 'escaped' }))).toBeNull()
    expect(read(frame({ ...size, channel: 'another-visual' }))).toBeNull()
  })

  it('drops links that are not plain http(s)', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'orca://open',
      'data:text/html,hi',
      `https://example.com/${'a'.repeat(3000)}`,
      42
    ]) {
      expect(read(frame({ type: NATIVE_CHAT_VISUAL_OPEN_LINK_TYPE, url })), String(url)).toBeNull()
    }
  })

  it('drops non-finite heights, unknown requests, non-strings, junk and oversized messages', () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, '300', null]) {
      expect(read(frame({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, height })), String(height)).toBeNull()
    }
    expect(read(frame({ type: 'orca-visual-navigate' }))).toBeNull()
    expect(read('not json')).toBeNull()
    expect(read(null)).toBeNull()
    expect(read(undefined)).toBeNull()
    expect(
      read(frame({ type: NATIVE_CHAT_VISUAL_SIZE_TYPE, height: 300, pad: 'x'.repeat(9000) }))
    ).toBeNull()
  })
})

describe('buildMobileNativeChatVisualHostDocument', () => {
  const build = (visualDocument: string) =>
    buildMobileNativeChatVisualHostDocument({
      visualDocument,
      channel: CHANNEL,
      token: TOKEN,
      title: 'Usage </script><script>alert(1)</script>',
      mode: 'inline'
    })

  it('puts the visual in an opaque frame that may only run scripts', () => {
    const document = build('<p>hi</p>')
    expect(document).toContain("frame.setAttribute('sandbox', 'allow-scripts')")
    expect(document).not.toMatch(/allow-same-origin|allow-popups|allow-top-navigation|allow-forms/)
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'))
  })

  it('keeps the inline frame from scrolling so a drag on it scrolls the transcript', () => {
    expect(build('<p>hi</p>')).toContain("if (!C.fullscreen) frame.setAttribute('scrolling', 'no')")
  })

  it('embeds the visual and title as script literals that cannot close the host script', () => {
    const document = build('</script><script>window.ReactNativeWebView.postMessage("x")</script>')
    // One script element: the host's own.
    expect(document.match(/<script>/g)).toHaveLength(1)
    expect(document.match(/<\/script>/g)).toHaveLength(1)
  })

  it('relays only the child window on its own channel, links only with focus and activation', () => {
    const document = build('<p>hi</p>')
    expect(document).toContain('event.source !== frame.contentWindow')
    expect(document).toContain('data.channel !== C.channel')
    expect(document).toContain(JSON.stringify(CHANNEL))
    expect(document).toContain('document.activeElement !== frame')
    expect(document).toContain('activation.isActive')
    expect(document).toContain(JSON.stringify(TOKEN))
  })
})
