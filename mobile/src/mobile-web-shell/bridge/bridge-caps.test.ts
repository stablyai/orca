import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MAX_DEPTH,
  BRIDGE_MAX_EXTERNAL_LINK_CHARS,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_NODES,
  isBridgeExternalLinkUrl,
  readBridgeExternalLinkUrl,
  parseBridgeMessage,
  utf8ByteLength
} from './bridge-caps'

function jsonStringOfBytes(bytes: number): string {
  return `"${'x'.repeat(bytes - 2)}"`
}

function nestedArrays(levels: number): string {
  return `${'['.repeat(levels - 1)}0${']'.repeat(levels - 1)}`
}

function arrayOfNodes(nodes: number): string {
  return `[${Array.from({ length: nodes - 1 }, () => '0').join(',')}]`
}

describe('utf8ByteLength', () => {
  it('agrees with TextEncoder across the encoding widths', () => {
    const encoder = new TextEncoder()
    for (const sample of ['', 'plain ascii', 'é', 'ünïcodé', '中文', '😀', 'a😀b中é']) {
      expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).length)
    }
  })

  it('counts a lone surrogate as its replacement, like TextEncoder does', () => {
    const loneHigh = '\ud83d'
    const loneLow = '\ude00'
    expect(utf8ByteLength(loneHigh)).toBe(new TextEncoder().encode(loneHigh).length)
    expect(utf8ByteLength(`a${loneLow}b`)).toBe(new TextEncoder().encode(`a${loneLow}b`).length)
  })

  it('counts a surrogate pair once, not twice', () => {
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('😀😀')).toBe(8)
  })
})

function listingReply(rows: number): string {
  const records = Array.from({ length: rows }, (_, index) => ({
    id: index,
    name: `worktree-${index}`,
    branch: 'main',
    dirty: false
  }))
  return JSON.stringify({
    v: 1,
    type: 'reply',
    id: 'a'.repeat(22),
    payload: { ok: true, result: records }
  })
}

describe('parseBridgeMessage byte cap', () => {
  it('accepts a frame of exactly the cap', () => {
    const raw = jsonStringOfBytes(BRIDGE_MAX_MESSAGE_BYTES)
    expect(utf8ByteLength(raw)).toBe(BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseBridgeMessage(raw, 'page-to-shell').ok).toBe(true)
  })

  it('refuses a frame one byte over the cap', () => {
    const raw = jsonStringOfBytes(BRIDGE_MAX_MESSAGE_BYTES + 1)
    expect(parseBridgeMessage(raw, 'page-to-shell')).toEqual({ ok: false, refusal: 'oversized' })
  })

  it('measures bytes, not code units, so multi-byte text cannot slip past', () => {
    // Half the cap in code units, every one of them two bytes: under the length guard, over the cap.
    const body = 'é'.repeat(BRIDGE_MAX_MESSAGE_BYTES / 2)
    const raw = `"${body}"`
    expect(raw.length).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseBridgeMessage(raw, 'page-to-shell')).toEqual({ ok: false, refusal: 'oversized' })
  })
})

describe('parseBridgeMessage document caps', () => {
  it('refuses text that is not JSON', () => {
    expect(parseBridgeMessage('{', 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'malformed-json'
    })
    expect(parseBridgeMessage('', 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'malformed-json'
    })
  })

  it('accepts nesting of exactly the depth cap', () => {
    expect(parseBridgeMessage(nestedArrays(BRIDGE_MAX_DEPTH), 'page-to-shell').ok).toBe(true)
  })

  it('refuses nesting one level past the depth cap', () => {
    expect(parseBridgeMessage(nestedArrays(BRIDGE_MAX_DEPTH + 1), 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-deep'
    })
  })

  it('counts object nesting the same as array nesting', () => {
    const deep = `${'{"a":'.repeat(BRIDGE_MAX_DEPTH)}0${'}'.repeat(BRIDGE_MAX_DEPTH)}`
    expect(parseBridgeMessage(deep, 'page-to-shell')).toEqual({ ok: false, refusal: 'too-deep' })
  })

  it('accepts exactly the node cap', () => {
    expect(parseBridgeMessage(arrayOfNodes(BRIDGE_MAX_NODES), 'page-to-shell').ok).toBe(true)
  })

  it('refuses one node past the cap', () => {
    expect(parseBridgeMessage(arrayOfNodes(BRIDGE_MAX_NODES + 1), 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-many-nodes'
    })
  })

  it('counts object values as nodes too', () => {
    const entries = Array.from({ length: BRIDGE_MAX_NODES }, (_, index) => `"k${index}":0`)
    expect(parseBridgeMessage(`{${entries.join(',')}}`, 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-many-nodes'
    })
  })

  it('returns the parsed document when every cap holds', () => {
    expect(parseBridgeMessage('{"v":1,"type":"ready"}', 'page-to-shell')).toEqual({
      ok: true,
      message: { v: 1, type: 'ready' }
    })
  })
})

describe('parseBridgeMessage direction', () => {
  it('lets a reply past the node cap through, and refuses the same document from the page', () => {
    const raw = listingReply(5_000)
    expect(utf8ByteLength(raw)).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseBridgeMessage(raw, 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-many-nodes'
    })
    expect(parseBridgeMessage(raw, 'shell-to-page').ok).toBe(true)
  })

  it('lets a reply nest past the depth cap, and refuses the same nesting from the page', () => {
    const raw = nestedArrays(BRIDGE_MAX_DEPTH + 1)
    expect(parseBridgeMessage(raw, 'shell-to-page').ok).toBe(true)
    expect(parseBridgeMessage(raw, 'page-to-shell')).toEqual({ ok: false, refusal: 'too-deep' })
  })

  it('holds a reply to the frame byte cap all the same', () => {
    expect(
      parseBridgeMessage(jsonStringOfBytes(BRIDGE_MAX_MESSAGE_BYTES), 'shell-to-page').ok
    ).toBe(true)
    expect(
      parseBridgeMessage(jsonStringOfBytes(BRIDGE_MAX_MESSAGE_BYTES + 1), 'shell-to-page')
    ).toEqual({
      ok: false,
      refusal: 'oversized'
    })
  })

  it('holds a reply to being JSON at all', () => {
    expect(parseBridgeMessage('{', 'shell-to-page')).toEqual({
      ok: false,
      refusal: 'malformed-json'
    })
  })
})

// Use the shared URL parser rule at both page call and shell envelope; an allowlisted absolute scheme is required before device dispatch.
describe('the URLs a page may hand to the shell', () => {
  it('takes the three schemes a task source produces, on any host and any path', () => {
    for (const url of [
      'https://github.com/stablyai/orca/pull/1',
      'http://localhost:3000/x?y=1#z',
      'mailto:someone@example.com?subject=hi',
      'https://user:pass@example.com/a%20b'
    ]) {
      expect(isBridgeExternalLinkUrl(url), url).toBe(true)
    }
  })

  it('refuses every other scheme, including one hiding an allowed word', () => {
    for (const url of [
      'javascript:alert("https://example.com")',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'intent://scan/#Intent;scheme=zxing;end',
      'orca-mobile-web://session/x',
      'ftp://example.com/f'
    ]) {
      expect(isBridgeExternalLinkUrl(url), url).toBe(false)
    }
  })

  it('refuses a target that is not an absolute URL at all', () => {
    for (const url of ['', '/h/host-a/tasks', '//example.com', 'example.com', 'https://']) {
      expect(isBridgeExternalLinkUrl(url), url).toBe(false)
    }
  })

  it('holds the URL to the same cap a route href gets', () => {
    const under = `https://example.com/${'a'.repeat(BRIDGE_MAX_EXTERNAL_LINK_CHARS - 20)}`
    expect(under).toHaveLength(BRIDGE_MAX_EXTERNAL_LINK_CHARS)
    expect(isBridgeExternalLinkUrl(under)).toBe(true)
    expect(isBridgeExternalLinkUrl(`${under}a`)).toBe(false)
  })
})

// Forward normalized hrefs: WHATWG strips controls and trims spaces, while valid bare origins gain a slash. Rejecting every changed spelling would reject ordinary URLs.
describe('the URL that actually crosses', () => {
  it('is the parsed href, for the four shapes that survive the scheme check unchanged', () => {
    expect(readBridgeExternalLinkUrl('ht\ntps://example.com')).toBe('https://example.com/')
    expect(readBridgeExternalLinkUrl('https://example.com/a\r\n')).toBe('https://example.com/a')
    expect(readBridgeExternalLinkUrl('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(readBridgeExternalLinkUrl('https:example.com')).toBe('https://example.com/')
  })

  it('takes an ordinary URL that differs from its own href, rather than refusing it', () => {
    expect(readBridgeExternalLinkUrl('https://example.com')).toBe('https://example.com/')
  })

  it('holds the normalized form to the cap, not just the string it was handed', () => {
    // Percent-encoding expands, so a raw string inside the cap can normalize past it.
    const raw = `https://example.com/${'\u00e9'.repeat(BRIDGE_MAX_EXTERNAL_LINK_CHARS - 21)}`
    expect(raw.length).toBeLessThanOrEqual(BRIDGE_MAX_EXTERNAL_LINK_CHARS)
    expect(new URL(raw).href.length).toBeGreaterThan(BRIDGE_MAX_EXTERNAL_LINK_CHARS)
    expect(readBridgeExternalLinkUrl(raw)).toBeNull()
  })
})
