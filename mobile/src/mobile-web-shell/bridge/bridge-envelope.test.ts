import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../../transport/browser-screencast-protocol'
import { isRpcResponse } from '../../transport/rpc-response-shape'
import {
  BRIDGE_MAX_MESSAGE_BYTES,
  BRIDGE_MAX_METHOD_CHARS,
  BRIDGE_MAX_REPLY_PARTS,
  BRIDGE_MAX_ROUTE_PARAM_CHARS,
  BRIDGE_MAX_ROUTE_PARAMS,
  BRIDGE_MAX_ROUTE_PATHNAME_CHARS,
  BRIDGE_MAX_VIEWPORT_COLS,
  BRIDGE_MAX_VIEWPORT_ROWS
} from './bridge-caps'
import { BRIDGE_HAPTICS_NOTIFY } from './bridge-haptics-notify'
import {
  BRIDGE_FAULT_GRANT,
  BRIDGE_NAVIGATE_BACK_NOTIFY,
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  readBridgeHostMessage,
  type BridgeHostMessage
} from './bridge-envelope'
import { BRIDGE_BACK_CLAIM_NOTIFY } from './bridge-page-back'
import { BRIDGE_PAGE_PAINTED } from './bridge-page-painted'

const ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const CONNECTION = {
  state: 'connected',
  reconnectAttempt: 0,
  lastConnectedAt: 1_700_000_000_000,
  lastInboundAt: null,
  generation: 2
}
const GRANTS = { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: [] }
const SUCCESS_PAYLOAD = {
  id: 'r1',
  ok: true,
  result: { worktrees: [] },
  _meta: { runtimeId: 'runtime-a' }
}

const BINARY_FRAME = {
  b64: 'AAAA',
  format: 'jpeg',
  frameSeq: 7,
  metadata: { imageWidth: 390, imageHeight: 844, timestamp: 1_700_000_000.5 }
}

type BridgeBinaryEvent = Extract<BridgeHostMessage, { binary: unknown }>

function asDecodedFrameFields(
  binary: BridgeBinaryEvent['binary']
): Omit<BrowserScreencastFrame, 'image'> {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: binary.frameSeq,
    format: binary.format,
    metadata: binary.metadata
  }
}

function readClient(message: unknown): ReturnType<typeof readBridgeClientMessage> {
  return readBridgeClientMessage(JSON.stringify(message))
}

function readHost(message: unknown): ReturnType<typeof readBridgeHostMessage> {
  return readBridgeHostMessage(JSON.stringify(message))
}

function client(fields: Record<string, unknown>): Record<string, unknown> {
  return { v: BRIDGE_PROTOCOL_VERSION, ...fields }
}

describe('client messages', () => {
  const accepted = [
    ['ready', { type: 'ready' }],
    ['a page painted notify', { type: 'notify', name: BRIDGE_PAGE_PAINTED }],
    ['a back claim', { type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: true }],
    [
      'a back claim being let go',
      { type: 'notify', name: BRIDGE_BACK_CLAIM_NOTIFY, claimed: false }
    ],
    ['request without params', { type: 'request', id: ID, method: 'status.get' }],
    ['request with params', { type: 'request', id: ID, method: 'status.get', params: { a: 1 } }],
    [
      'request with options',
      {
        type: 'request',
        id: ID,
        method: 'status.get',
        options: { timeoutMs: 5000, budgetSpansConnect: true, failWhenDisconnected: false }
      }
    ],
    ['subscribe', { type: 'subscribe', id: ID, method: 'terminal.subscribe', params: { t: 'x' } }],
    [
      'subscribe wanting binary',
      { type: 'subscribe', id: ID, method: 'browser.screencast', params: {}, wantsBinary: true }
    ],
    ['cancel of a request', { type: 'cancel', id: ID, target: 'request' }],
    ['cancel of a subscription', { type: 'cancel', id: ID, target: 'subscription' }],
    ['ack', { type: 'ack', id: ID, seq: 0 }],
    ['foreground notify', { type: 'notify', name: 'foreground' }],
    ['foreground notify with a reason', { type: 'notify', name: 'foreground', reason: 'focus' }],
    [
      'terminal viewport notify',
      { type: 'notify', name: 'terminalViewport', terminal: 't1', cols: 80, rows: 24 }
    ],
    [
      'a terminal viewport notify of exactly the bounds',
      {
        type: 'notify',
        name: 'terminalViewport',
        terminal: 't1',
        cols: BRIDGE_MAX_VIEWPORT_COLS,
        rows: BRIDGE_MAX_VIEWPORT_ROWS
      }
    ],
    [
      'a page fault notify',
      {
        type: 'notify',
        name: BRIDGE_FAULT_GRANT,
        error: { category: 'Error', message: 'the route threw', isRpcDeliveryUnknown: false }
      }
    ],
    ['a navigate-back notify', { type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY }],
    ...(['mediumImpact', 'selection', 'success', 'error', 'edgeBump'] as const).map(
      (kind) =>
        [`a ${kind} haptics notify`, { type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind }] as const
    ),
    [
      'an escaped-name navigate notify',
      { type: 'notify', name: 'navigate', href: '/h/a%20b/%2ex?from=list' }
    ],
    ['close', { type: 'close' }]
  ] as const

  for (const [name, fields] of accepted) {
    it(`accepts ${name}`, () => {
      expect(readClient(client(fields)).ok).toBe(true)
    })
  }

  it('drops a target a page attached to a navigate-back, rather than carrying it to the shell', () => {
    // Assert parsed output drops additive fields; newer desktop bundles must remain usable with older shells.
    const read = readClient(
      client({ type: 'notify', name: BRIDGE_NAVIGATE_BACK_NOTIFY, href: '/h/host-a' })
    )
    expect(read).toEqual({
      ok: true,
      message: {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: BRIDGE_NAVIGATE_BACK_NOTIFY
      }
    })
  })

  const refused = [
    ['a version this shell does not speak', { ...client({ type: 'ready' }), v: 2 }],
    ['a missing version', { type: 'ready' }],
    ['an unknown type', client({ type: 'hello' })],
    ['an id of the wrong length', client({ type: 'cancel', id: 'short', target: 'request' })],
    [
      'a method over the cap',
      client({ type: 'request', id: ID, method: 'm'.repeat(BRIDGE_MAX_METHOD_CHARS + 1) })
    ],
    ['an empty method', client({ type: 'request', id: ID, method: '' })],
    ['an unknown cancel target', client({ type: 'cancel', id: ID, target: 'stream' })],
    ['a negative ack sequence', client({ type: 'ack', id: ID, seq: -1 })],
    ['a fractional ack sequence', client({ type: 'ack', id: ID, seq: 1.5 })],
    ['an unknown notify name', client({ type: 'notify', name: 'battery' })],
    ['an unknown foreground reason', client({ type: 'notify', name: 'foreground', reason: 'tap' })],
    [
      'a viewport of zero columns',
      client({ type: 'notify', name: 'terminalViewport', terminal: 't1', cols: 0, rows: 24 })
    ],
    [
      'a viewport one column over the bound',
      client({
        type: 'notify',
        name: 'terminalViewport',
        terminal: 't1',
        cols: BRIDGE_MAX_VIEWPORT_COLS + 1,
        rows: 24
      })
    ],
    [
      'a viewport one row over the bound',
      client({
        type: 'notify',
        name: 'terminalViewport',
        terminal: 't1',
        cols: 80,
        rows: BRIDGE_MAX_VIEWPORT_ROWS + 1
      })
    ],
    ['a page fault carrying no error', client({ type: 'notify', name: BRIDGE_FAULT_GRANT })],
    [
      'a page fault whose error is not a capture',
      client({ type: 'notify', name: BRIDGE_FAULT_GRANT, error: 'the route threw' })
    ],
    [
      'a haptic this app has no function for',
      client({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY, kind: 'heavyImpact' })
    ],
    ['a haptics notify naming no kind', client({ type: 'notify', name: BRIDGE_HAPTICS_NOTIFY })],
    ...['/h/../a', '/h/%2e%2e/a', '/h/%2E%2E/a', '/h/.%2e/a', '/h/%2e/a'].map(
      (href) =>
        [
          `a navigate dot segment ${href}`,
          client({ type: 'notify', name: 'navigate', href })
        ] as const
    ),
    ['a bare array', []],
    ['a bare string', 'ready']
  ] as const

  for (const [name, message] of refused) {
    it(`refuses ${name}`, () => {
      expect(readClient(message)).toEqual({ ok: false, refusal: 'unrecognised-message' })
    })
  }

  it('accepts a method of exactly the cap', () => {
    const method = 'm'.repeat(BRIDGE_MAX_METHOD_CHARS)
    expect(readClient(client({ type: 'request', id: ID, method })).ok).toBe(true)
  })

  it('keeps an absent params absent, so the host replays the arity the page used', () => {
    const read = readClient(client({ type: 'request', id: ID, method: 'status.get' }))
    expect(read).toEqual({
      ok: true,
      message: { v: BRIDGE_PROTOCOL_VERSION, type: 'request', id: ID, method: 'status.get' }
    })
  })

  it('keeps an explicit null params, which is not the same call', () => {
    const read = readClient(client({ type: 'request', id: ID, method: 'status.get', params: null }))
    expect(read.ok && read.message.type === 'request' && read.message.params).toBeNull()
  })

  it('drops a field it does not know rather than refusing the frame', () => {
    const read = readClient(client({ type: 'ready', sentAt: 5 }))
    expect(read).toEqual({ ok: true, message: { v: BRIDGE_PROTOCOL_VERSION, type: 'ready' } })
  })

  it('carries the frame refusal through rather than relabelling it', () => {
    expect(readBridgeClientMessage('{')).toEqual({ ok: false, refusal: 'malformed-json' })
  })
})

describe('host messages', () => {
  function initRoute(route: unknown): Record<string, unknown> {
    return client({
      type: 'init',
      sessionId: 's1',
      buildId: 'b1',
      connection: CONNECTION,
      grants: GRANTS,
      route
    })
  }

  const accepted = [
    [
      'init',
      { type: 'init', sessionId: 's1', buildId: 'b1', connection: CONNECTION, grants: GRANTS }
    ],
    [
      'an init naming the screen the page should open',
      {
        type: 'init',
        sessionId: 's1',
        buildId: 'b1',
        connection: CONNECTION,
        grants: GRANTS,
        route: { pathname: '/h/host-a/session/wt-1', params: { name: 'a branch' } }
      }
    ],
    [
      'an init whose segments merely contain dots, which are names and not navigation',
      {
        type: 'init',
        sessionId: 's1',
        buildId: 'b1',
        connection: CONNECTION,
        grants: GRANTS,
        route: { pathname: '/h/a..b/...' }
      }
    ],
    [
      'an init whose segments merely carry percent escapes, which are text and not navigation',
      {
        type: 'init',
        sessionId: 's1',
        buildId: 'b1',
        connection: CONNECTION,
        grants: GRANTS,
        // Allow escaped text and encoded slashes within named segments; reject dot-segment semantics rather than all escapes.
        route: { pathname: '/h/a%20b/%2ex/a%2fb' }
      }
    ],
    ['state', { type: 'state', connection: CONNECTION }],
    ['a back press handed to the page', { type: 'back' }],
    ['a whole reply', { type: 'reply', id: ID, payload: SUCCESS_PAYLOAD }],
    [
      'a failure reply, which is data and not a rejection',
      {
        type: 'reply',
        id: ID,
        payload: {
          id: 'r1',
          ok: false,
          error: { code: 'forbidden', message: 'no', data: { scope: 'mobile' } },
          _meta: { runtimeId: 'runtime-a' }
        }
      }
    ],
    ['a reply part', { type: 'reply', id: ID, part: { i: 0, of: 2 }, chunk: '{"id"' }],
    ['an event', { type: 'event', id: ID, seq: 0, payload: { type: 'data' } }],
    ['a binary event', { type: 'event', id: ID, seq: 1, binary: BINARY_FRAME }],
    ['an unsubscribed end', { type: 'end', id: ID, reason: 'unsubscribed' }],
    ['a closed end', { type: 'end', id: ID, reason: 'closed' }],
    ['an overflow end', { type: 'end', id: ID, reason: 'overflow' }],
    [
      'an error',
      {
        type: 'error',
        id: ID,
        error: { category: 'Error', message: 'x', isRpcDeliveryUnknown: true }
      }
    ],
    [
      'an error whose code is an object',
      {
        type: 'error',
        id: ID,
        error: { category: 'Error', message: 'x', isRpcDeliveryUnknown: false, code: { n: 1 } }
      }
    ]
  ] as const

  for (const [name, fields] of accepted) {
    it(`accepts ${name}`, () => {
      expect(readHost(client(fields)).ok).toBe(true)
    })
  }

  it("keeps the host's stored name identity, which the page's title rule reads", () => {
    const host = {
      id: 'host-a',
      name: 'm4airs-Air',
      lastKnownMachineName: 'm4airs-Air',
      lastKnownHostPlatform: 'darwin',
      endpoint: 'ws://host-a',
      lastConnected: 0
    }
    const read = readHost(
      client({
        type: 'init',
        sessionId: 's1',
        buildId: 'b1',
        connection: CONNECTION,
        grants: GRANTS,
        host
      })
    )
    expect(read.ok && read.message.type === 'init' ? read.message.host : null).toEqual(host)
  })

  it('drops a name-identity value this page cannot read instead of refusing the init', () => {
    const read = readHost(
      client({
        type: 'init',
        sessionId: 's1',
        buildId: 'b1',
        connection: CONNECTION,
        grants: GRANTS,
        host: {
          id: 'host-a',
          name: 'Studio',
          personalName: '',
          lastKnownMachineName: 'Studio',
          lastKnownHostPlatform: 'plan9',
          endpoint: 'ws://host-a',
          lastConnected: 0
        }
      })
    )
    const host = read.ok && read.message.type === 'init' ? read.message.host : null
    expect(host).toMatchObject({ id: 'host-a', name: 'Studio', lastKnownMachineName: 'Studio' })
    expect(host?.personalName).toBeUndefined()
    expect(host?.lastKnownHostPlatform).toBeUndefined()
  })

  const refused = [
    [
      'an init without a build id',
      client({ type: 'init', sessionId: 's1', buildId: '', connection: CONNECTION, grants: GRANTS })
    ],
    [
      'a connection state the transport does not have',
      client({ type: 'state', connection: { ...CONNECTION, state: 'idle' } })
    ],
    [
      'a connection snapshot missing its generation',
      client({
        type: 'state',
        connection: {
          state: 'connected',
          reconnectAttempt: 0,
          lastConnectedAt: null,
          lastInboundAt: null
        }
      })
    ],
    [
      'a reply whose payload is not an envelope',
      client({ type: 'reply', id: ID, payload: { ok: true } })
    ],
    [
      'a part index past the part cap',
      client({
        type: 'reply',
        id: ID,
        part: { i: BRIDGE_MAX_REPLY_PARTS, of: BRIDGE_MAX_REPLY_PARTS },
        chunk: 'x'
      })
    ],
    ['a part count of zero', client({ type: 'reply', id: ID, part: { i: 0, of: 0 }, chunk: 'x' })],
    [
      'a binary event carrying only its bytes',
      client({ type: 'event', id: ID, seq: 1, binary: { b64: 'AAAA' } })
    ],
    [
      'a binary event without the screencast frame seq',
      client({
        type: 'event',
        id: ID,
        seq: 1,
        binary: { b64: 'AAAA', format: 'jpeg', metadata: {} }
      })
    ],
    [
      'a binary event in a format the screencast cannot produce',
      client({ type: 'event', id: ID, seq: 1, binary: { ...BINARY_FRAME, format: 'webp' } })
    ],
    [
      'a binary event whose metadata is not an object',
      client({ type: 'event', id: ID, seq: 1, binary: { ...BINARY_FRAME, metadata: 7 } })
    ],

    [
      'an end for a reason that is not one of the three',
      client({ type: 'end', id: ID, reason: 'done' })
    ],
    // replaceState rejects cross-origin protocol-relative paths; queries/fragments belong in params instead of requiring URL re-parsing.
    ['an init route that is not rooted', initRoute({ pathname: 'h/host-a' })],
    ['an init route that is protocol-relative', initRoute({ pathname: '//evil.example/h' })],
    ['an init route that is backslash-relative', initRoute({ pathname: '/\\evil.example/h' })],
    ['an init route carrying its own query', initRoute({ pathname: '/h/a?name=b' })],
    ['an init route carrying a fragment', initRoute({ pathname: '/h/a#top' })],
    // Reject paths that replaceState normalizes away from their intended host prefix, including dot segments and backslashes.
    ['an init route that climbs out of its prefix', initRoute({ pathname: '/../../etc' })],
    [
      'an init route with an interior dot segment',
      initRoute({ pathname: '/h/a/../render-check-host' })
    ],
    ['an init route ending in a dot segment', initRoute({ pathname: '/h/a/..' })],
    ['an init route with a single dot segment', initRoute({ pathname: '/h/./a' })],
    ['an init route with an interior backslash', initRoute({ pathname: '/h/a\\b' })],
    // Encoded dots resolve as dot segments too, so they must not bypass the prefix guard.
    [
      'an init route that climbs out of its prefix percent-encoded',
      initRoute({ pathname: '/h/%2e%2e/render-check-host' })
    ],
    [
      'an init route that climbs out of its prefix in capitals',
      initRoute({ pathname: '/h/%2E%2E/render-check-host' })
    ],
    ['an init route with a half-encoded dot segment', initRoute({ pathname: '/h/.%2e/a' })],
    ['an init route with a single encoded dot segment', initRoute({ pathname: '/h/%2e/a' })],
    ['an init route with a literal parent segment', initRoute({ pathname: '/h/../a' })],
    ['an init route with a lower encoded parent segment', initRoute({ pathname: '/h/%2e%2e/a' })],
    ['an init route with an upper encoded parent segment', initRoute({ pathname: '/h/%2E%2E/a' })],
    ['an init route with an empty interior segment', initRoute({ pathname: '/h//a' })],
    ['an init route with an empty pathname', initRoute({ pathname: '' })],
    [
      'an init route over the pathname cap',
      initRoute({ pathname: `/${'h'.repeat(BRIDGE_MAX_ROUTE_PATHNAME_CHARS)}` })
    ],
    [
      'an init route with more params than the cap',
      initRoute({
        pathname: '/h/a',
        params: Object.fromEntries(
          Array.from({ length: BRIDGE_MAX_ROUTE_PARAMS + 1 }, (_value, index) => [
            `k${String(index)}`,
            'v'
          ])
        )
      })
    ],
    [
      'an init route with a param value over the cap',
      initRoute({
        pathname: '/h/a',
        params: { name: 'v'.repeat(BRIDGE_MAX_ROUTE_PARAM_CHARS + 1) }
      })
    ],
    ['an init route whose param is not a string', initRoute({ pathname: '/h/a', params: { n: 1 } })]
  ] as const

  for (const [name, message] of refused) {
    it(`refuses ${name}`, () => {
      expect(readHost(message)).toEqual({ ok: false, refusal: 'unrecognised-message' })
    })
  }

  it('accepts a part index of exactly one below the part cap', () => {
    const part = { i: BRIDGE_MAX_REPLY_PARTS - 1, of: BRIDGE_MAX_REPLY_PARTS }
    expect(readHost(client({ type: 'reply', id: ID, part, chunk: 'x' })).ok).toBe(true)
  })

  it('passes a reply payload through verbatim, including fields it does not know', () => {
    const payload = {
      ...SUCCESS_PAYLOAD,
      streaming: true,
      _meta: { runtimeId: 'runtime-a', hostVersion: '9.9.9' },
      hint: 'from a newer host'
    }
    const read = readHost(client({ type: 'reply', id: ID, payload }))
    expect(
      read.ok && read.message.type === 'reply' && 'payload' in read.message && read.message.payload
    ).toEqual(payload)
  })
})

describe('the reply reader is the native acceptance predicate', () => {
  // Use isRpcResponse as the acceptance oracle: both bridge and native transport must agree, including refusal of ok:true with no result.
  const payloads: [string, unknown][] = [
    ['a success the runtime stamped', { id: 'r1', ok: true, result: 1, _meta: { runtimeId: 'a' } }],
    ['a success with no `_meta` at all', { id: 'r1', ok: true, result: 1 }],
    ['a success whose result is null', { id: 'r1', ok: true, result: null }],
    ['a streaming success with no `_meta`', { id: 'r1', ok: true, result: 1, streaming: true }],
    ['a failure with no `_meta`', { id: 'r1', ok: false, error: { code: 'x', message: 'y' } }],
    [
      'a failure whose runtime id is null, which the shared envelope allows',
      { id: 'r1', ok: false, error: { code: 'x', message: 'y' }, _meta: { runtimeId: null } }
    ],
    ['`ok` with no result key', { id: 'r1', ok: true }],
    ['a failure carrying no error', { id: 'r1', ok: false }],
    [
      'a failure whose error code is a number',
      { id: 'r1', ok: false, error: { code: 1, message: 'y' } }
    ],
    ['a reply with no id', { ok: true, result: 1 }],
    ['a reply whose id is a number', { id: 1, ok: true, result: 1 }]
  ]

  for (const [name, payload] of payloads) {
    it(`agrees with the native predicate on ${name}`, () => {
      expect(readHost(client({ type: 'reply', id: ID, payload })).ok).toBe(isRpcResponse(payload))
    })
  }

  it('hands a reply with no `_meta` back verbatim', () => {
    const payload = { id: 'r1', ok: true, result: { rows: 2 }, hint: 'from a newer host' }
    const read = readHost(client({ type: 'reply', id: ID, payload }))
    expect(
      read.ok && read.message.type === 'reply' && 'payload' in read.message && read.message.payload
    ).toEqual(payload)
  })
})

describe('the screencast frame reader', () => {
  it('refuses numeric strings in screencast metadata', () => {
    const keys = [
      'offsetTop',
      'pageScaleFactor',
      'deviceWidth',
      'deviceHeight',
      'imageWidth',
      'imageHeight',
      'scrollOffsetX',
      'scrollOffsetY',
      'timestamp'
    ]
    for (const key of keys) {
      const binary = { ...BINARY_FRAME, metadata: { [key]: '390' } }
      expect([key, readHost(client({ type: 'event', id: ID, seq: 1, binary })).ok]).toEqual([
        key,
        false
      ])
    }
  })

  it('preserves binary event fields and their decoded-frame type compatibility', () => {
    const read = readHost(client({ type: 'event', id: ID, seq: 1, binary: BINARY_FRAME }))
    const binary =
      read.ok && read.message.type === 'event' && 'binary' in read.message
        ? read.message.binary
        : null
    expect(binary).toEqual(BINARY_FRAME)
    expect(binary === null ? null : asDecodedFrameFields(binary)).toEqual({
      opcode: BrowserScreencastOpcode.Frame,
      seq: BINARY_FRAME.frameSeq,
      format: BINARY_FRAME.format,
      metadata: BINARY_FRAME.metadata
    })
  })
})

describe('the readers bound their two directions differently', () => {
  const records = Array.from({ length: 5_000 }, (_, index) => ({
    id: index,
    name: `worktree-${index}`,
    branch: 'main',
    dirty: false
  }))

  it('accepts a reply carrying more values than the page-to-shell node cap', () => {
    const read = readHost({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'reply',
      id: ID,
      payload: { ...SUCCESS_PAYLOAD, result: records }
    })
    expect(
      read.ok && read.message.type === 'reply' && 'payload' in read.message && read.message.payload
    ).toEqual({
      ...SUCCESS_PAYLOAD,
      result: records
    })
  })

  it('refuses the page sending that many values back the other way', () => {
    expect(
      readClient(client({ type: 'request', id: ID, method: 'worktree.list', params: { records } }))
    ).toEqual({ ok: false, refusal: 'too-many-nodes' })
  })

  it('still refuses a host frame one byte over the frame cap', () => {
    const envelope = (result: string) =>
      JSON.stringify({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'reply',
        id: ID,
        payload: { ...SUCCESS_PAYLOAD, result }
      })
    const overhead = new TextEncoder().encode(envelope('')).byteLength
    const raw = envelope('x'.repeat(BRIDGE_MAX_MESSAGE_BYTES + 1 - overhead))
    expect(new TextEncoder().encode(raw).byteLength).toBe(BRIDGE_MAX_MESSAGE_BYTES + 1)
    expect(readBridgeHostMessage(raw)).toEqual({ ok: false, refusal: 'oversized' })
  })
})

// Pathnames and returned navigation hrefs share one segment rule; disagreement would expose a path through notify.
describe('navigate query boundaries', () => {
  it('refuses query-ended dot segments through the navigate reader', () => {
    for (const href of ['/h/..?x', '/h/%2e%2e?x', '/h/.?x', '/h/a/..?x', '/h/..?']) {
      expect(readClient(client({ type: 'notify', name: 'navigate', href })), href).toEqual({
        ok: false,
        refusal: 'unrecognised-message'
      })
    }
  })
})
