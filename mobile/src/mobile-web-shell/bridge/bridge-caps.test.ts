import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MAX_DEPTH,
  BRIDGE_MAX_EXTERNAL_LINK_CHARS,
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_METHOD_CHARS,
  BRIDGE_MAX_NODES,
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_REPLY_BYTES,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_DIRECTIONS,
  BRIDGE_MAX_SUBSCRIPTIONS,
  isBridgeExternalLinkUrl,
  readBridgeExternalLinkUrl,
  parseBridgeMessage,
  utf8ByteLength
} from './bridge-caps'

/** A JSON document of exactly `bytes` UTF-8 bytes: a quoted run of ASCII. */
function jsonStringOfBytes(bytes: number): string {
  return `"${'x'.repeat(bytes - 2)}"`
}

/** A scalar nested inside `levels - 1` arrays, so the scalar itself sits at `levels`. */
function nestedArrays(levels: number): string {
  return `${'['.repeat(levels - 1)}0${']'.repeat(levels - 1)}`
}

/** An array holding `nodes - 1` scalars, so the array and its values total `nodes`. */
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

/** A listing reply of the shape the node cap would refuse: `rows` records of four fields each. */
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

describe('the agreed numbers', () => {
  it('pins what a released shell and a served page believe about each other', () => {
    // These are wire, not tuning: the page bundle and the installed shell agree on them without
    // ever negotiating, so a change here is a change both sides have to ship for.
    expect({
      messageBytes: BRIDGE_MAX_MESSAGE_BYTES,
      depth: BRIDGE_MAX_DEPTH,
      nodes: BRIDGE_MAX_NODES,
      methodChars: BRIDGE_MAX_METHOD_CHARS,
      pendingRequests: BRIDGE_MAX_PENDING_REQUESTS,
      subscriptions: BRIDGE_MAX_SUBSCRIPTIONS,
      replyBytes: BRIDGE_MAX_REPLY_BYTES,
      replyParts: BRIDGE_MAX_REPLY_PARTS
    }).toEqual({
      messageBytes: 655_360,
      depth: 16,
      nodes: 20_000,
      methodChars: 64,
      pendingRequests: 64,
      subscriptions: 32,
      replyBytes: 8_388_608,
      replyParts: 27
    })
  })
})

describe('derived caps', () => {
  it('allows enough parts for a ceiling-sized reply whose every byte re-escapes', () => {
    // A chunk is JSON text inside a JSON string, so re-escaping it at worst doubles it.
    const worstCaseFrames = Math.ceil((BRIDGE_MAX_REPLY_BYTES * 2) / BRIDGE_MAX_MESSAGE_BYTES)
    expect(BRIDGE_MAX_REPLY_PARTS).toBeGreaterThan(worstCaseFrames)
  })
})

describe('parseBridgeMessage direction', () => {
  it('names both directions and nothing else', () => {
    expect(BRIDGE_DIRECTIONS).toEqual(['page-to-shell', 'shell-to-page'])
  })

  it('lets a reply past the node cap through, and refuses the same document from the page', () => {
    const raw = listingReply(5_000)
    expect(utf8ByteLength(raw)).toBeLessThan(BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseBridgeMessage(raw, 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-many-nodes'
    })
    expect(parseBridgeMessage(raw, 'shell-to-page').ok).toBe(true)
  })

  it('accepts exactly the node count the design note called out', () => {
    // 5 000 records x 4 fields, plus the records and the array: past 20 000 either way you count.
    expect(parseBridgeMessage(arrayOfNodes(25_000), 'shell-to-page').ok).toBe(true)
    expect(parseBridgeMessage(arrayOfNodes(25_000), 'page-to-shell')).toEqual({
      ok: false,
      refusal: 'too-many-nodes'
    })
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

/**
 * Which URLs the shell will open for a page.
 *
 * Parsed rather than prefix-matched on purpose: a scheme is what a URL parser says it is, and a
 * `startsWith('https:')` reads one out of `javascript:alert("https://x")`. Both sides run this —
 * the envelope refuses the frame and the page's seam refuses the call — so the rule lives once.
 */
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

/**
 * What crosses is the parser's URL, not the page's string.
 *
 * The WHATWG parser strips tab, LF and CR from anywhere in a URL and trims leading and trailing C0
 * and space before it reads the scheme. So a string the check accepts is not always the string a
 * handler should be given: forwarding it raw hands the device a URL that reads as allowed here and
 * as something else there. Normalizing is the fix; refusing anything that differs from its
 * normalization is not, because `https://example.com` differs from its own href by a slash.
 */
describe('the URL that actually crosses', () => {
  it('is the parsed href, for the four shapes that survive the scheme check unchanged', () => {
    expect(readBridgeExternalLinkUrl('ht\ntps://example.com')).toBe('https://example.com/')
    expect(readBridgeExternalLinkUrl('https://example.com/a\r\n')).toBe('https://example.com/a')
    expect(readBridgeExternalLinkUrl('  https://example.com/a  ')).toBe('https://example.com/a')
    expect(readBridgeExternalLinkUrl('https:example.com')).toBe('https://example.com/')
  })

  it('takes an ordinary URL that differs from its own href, rather than refusing it', () => {
    // The whole reason this normalizes instead of comparing: a bare origin gains a path slash.
    expect(readBridgeExternalLinkUrl('https://example.com')).toBe('https://example.com/')
  })

  it('answers null for exactly what the predicate refuses', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', '/h/host-a/tasks', '']) {
      expect(readBridgeExternalLinkUrl(url), url).toBeNull()
      expect(isBridgeExternalLinkUrl(url), url).toBe(false)
    }
  })

  it('holds the normalized form to the cap, not just the string it was handed', () => {
    // Percent-encoding expands, so a raw string inside the cap can normalize past it.
    const raw = `https://example.com/${'\u00e9'.repeat(BRIDGE_MAX_EXTERNAL_LINK_CHARS - 21)}`
    expect(raw.length).toBeLessThanOrEqual(BRIDGE_MAX_EXTERNAL_LINK_CHARS)
    expect(new URL(raw).href.length).toBeGreaterThan(BRIDGE_MAX_EXTERNAL_LINK_CHARS)
    expect(readBridgeExternalLinkUrl(raw)).toBeNull()
  })
})
