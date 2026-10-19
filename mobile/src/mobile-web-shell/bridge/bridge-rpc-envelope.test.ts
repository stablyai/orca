import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridgeInitFrame } from './bridge-init-frame'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_ENVELOPE_GRANT,
  readBridgeClientMessage,
  readBridgeHostMessage
} from './bridge-envelope'
import {
  BridgeRpcEnvelopeInvalidError,
  BridgeRpcEnvelopeUngrantedError
} from './bridge-client-errors'
import { INIT, createPageClient, readError } from './bridge-page-client-test-harness'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'

const ENVELOPE = { executionHost: 'runtime:a', nested: { list: [1, 'two', null, true] } }

function grantedPage() {
  const page = createPageClient()
  page.deliver({
    ...INIT,
    grants: { ...INIT.grants, native: [BRIDGE_RPC_ENVELOPE_GRANT] }
  })
  return page
}

function frameKey(json: string): string {
  return json.replace(/"id":"[^"]+"/, '"id":"_"')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bridge rpc envelope: page side', () => {
  it('posts the same bytes as before when there is no envelope or an empty one', () => {
    const page = grantedPage()
    void page.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50 })
    void page.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50, envelope: {} })
    page.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined)
    page.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined, {
      envelope: {}
    })
    const [, request, emptyRequest, subscribe, emptySubscribe] = page.sent.map(frameKey)
    expect(request).toBe(
      '{"v":1,"type":"request","id":"_","method":"worktree.ps","params":{"a":1},"options":{"timeoutMs":50}}'
    )
    expect(emptyRequest).toBe(request)
    expect(subscribe).toBe(
      '{"v":1,"type":"subscribe","id":"_","method":"terminal.subscribe","params":{"terminal":"t"}}'
    )
    expect(emptySubscribe).toBe(subscribe)
  })

  it('posts no options when the only option was the envelope, and keeps an empty bag', () => {
    const page = grantedPage()
    void page.client.sendRequest('worktree.ps', { a: 1 }, { envelope: {} })
    void page.client.sendRequest('worktree.ps', { a: 1 }, { envelope: ENVELOPE })
    void page.client.sendRequest('worktree.ps', { a: 1 }, {})
    const [, emptyOnly, envelopeOnly, emptyBag] = page.frames()
    expect(emptyOnly).not.toHaveProperty('options')
    expect(emptyOnly).not.toHaveProperty('envelope')
    expect(envelopeOnly).not.toHaveProperty('options')
    expect(envelopeOnly).toMatchObject({ envelope: ENVELOPE })
    expect(emptyBag).toMatchObject({ options: {} })
  })

  it('carries a granted envelope beside params, out of options', () => {
    const page = grantedPage()
    void page.client.sendRequest('worktree.ps', undefined, { timeoutMs: 50, envelope: ENVELOPE })
    page.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined, {
      envelope: ENVELOPE
    })
    const [, request, subscribe] = page.frames()
    expect(request).toMatchObject({ options: { timeoutMs: 50 }, envelope: ENVELOPE })
    expect(request).not.toHaveProperty('options.envelope')
    expect(subscribe).toMatchObject({ type: 'subscribe', envelope: ENVELOPE })
  })

  it('refuses an envelope the shell did not grant, and posts nothing', async () => {
    const page = createPageClient()
    page.start()
    const posted = page.sent.length
    const refusal = await page.client
      .sendRequest('worktree.ps', {}, { envelope: ENVELOPE })
      .catch(readError)
    expect(refusal).toBeInstanceOf(BridgeRpcEnvelopeUngrantedError)
    expect(refusal).toMatchObject({ code: 'bridge_rpc_envelope_ungranted' })
    expect(() =>
      page.client.subscribe('terminal.subscribe', {}, () => undefined, { envelope: ENVELOPE })
    ).toThrow(BridgeRpcEnvelopeUngrantedError)
    expect(page.sent).toHaveLength(posted)
  })

  it('refuses an envelope the shell reader would drop, instead of leaving the call pending', async () => {
    const page = grantedPage()
    const posted = page.sent.length
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a caller that widened the type, which the check exists for.
    const notJson = { when: new Date(0), skip: undefined } as unknown as Record<string, null>
    const refusal = await page.client
      .sendRequest('worktree.ps', {}, { envelope: notJson })
      .catch(readError)
    expect(refusal).toBeInstanceOf(BridgeRpcEnvelopeInvalidError)
    expect(refusal).toMatchObject({ code: 'bridge_rpc_envelope_invalid' })
    expect(page.sent).toHaveLength(posted)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a Date', new Date(0)]
  ])(
    'refuses %s as an envelope with a rejection, never a throw or a silent drop',
    async (_, value) => {
      const page = grantedPage()
      const posted = page.sent.length
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a caller that widened the type, which the check exists for.
      const envelope = value as unknown as Record<string, null>
      let answer: Promise<unknown> | undefined
      expect(() => {
        answer = page.client.sendRequest('worktree.ps', {}, { envelope })
      }).not.toThrow()
      expect(await answer?.catch(readError)).toBeInstanceOf(BridgeRpcEnvelopeInvalidError)
      expect(() =>
        page.client.subscribe('terminal.subscribe', {}, () => undefined, { envelope })
      ).toThrow(BridgeRpcEnvelopeInvalidError)
      expect(page.sent).toHaveLength(posted)
    }
  )
})

describe('bridge rpc envelope: shell side', () => {
  it('grants every session the envelope', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    expect(pair.client.getShellSession()?.grants.native).toContain(BRIDGE_RPC_ENVELOPE_GRANT)
  })

  it('hands a request and a subscribe envelope to the native client options', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    void pair.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50, envelope: ENVELOPE })
    void pair.client.sendRequest('worktree.ps', undefined, { envelope: ENVELOPE })
    pair.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined, {
      envelope: ENVELOPE
    })
    await pair.flush()
    expect(pair.rpc.requests.map((request) => request.args)).toEqual([
      ['worktree.ps', { a: 1 }, { timeoutMs: 50, envelope: ENVELOPE }],
      ['worktree.ps', undefined, { envelope: ENVELOPE }]
    ])
    expect(pair.rpc.streams.map((stream) => stream.envelope)).toEqual([ENVELOPE])
  })

  it('calls the native client exactly as before when no envelope crossed', async () => {
    const pair = createFakeBridgePortPair()
    await pair.flush()
    void pair.client.sendRequest('worktree.ps')
    void pair.client.sendRequest('worktree.ps', { a: 1 })
    void pair.client.sendRequest('worktree.ps', { a: 1 }, { timeoutMs: 50 })
    pair.client.subscribe('terminal.subscribe', { terminal: 't' }, () => undefined)
    await pair.flush()
    expect(pair.rpc.requests.map((request) => request.args)).toEqual([
      ['worktree.ps'],
      ['worktree.ps', { a: 1 }],
      ['worktree.ps', { a: 1 }, { timeoutMs: 50 }]
    ])
    expect(pair.rpc.streams.map((stream) => stream.envelope)).toEqual([undefined])
  })

  it('refuses a frame whose envelope is not a plain JSON object', () => {
    for (const envelope of [[1], 'x', null, 3]) {
      const frame = { v: 1, type: 'request', id: 'a'.repeat(22), method: 'm', envelope }
      expect(readBridgeClientMessage(JSON.stringify(frame))).toEqual({
        ok: false,
        refusal: 'unrecognised-message'
      })
    }
  })
})

describe('bridge rpc envelope: mixed versions', () => {
  it('an older page reading the new init ignores a grant name it does not know', () => {
    const init = createBridgeInitFrame({
      sessionId: 's',
      buildId: 'b',
      connection: INIT.connection,
      route: { pathname: '/h/a' },
      pageRoutes: [],
      granted: [BRIDGE_RPC_ENVELOPE_GRANT, 'someFutureGrant'],
      host: { id: 'a', name: 'A', endpoint: 'ws://a', lastConnected: 0 },
      storage: {}
    })
    const read = readBridgeHostMessage(JSON.stringify(init))
    expect(read.ok && read.message.type === 'init' && read.message.grants.native).toEqual([
      BRIDGE_RPC_ENVELOPE_GRANT,
      'someFutureGrant'
    ])
  })

  it('a shell drops a frame key it does not declare and still serves the frame', () => {
    // The rule an older shell applies to `envelope`: unknown keys are stripped, never refused.
    const frame = {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'request',
      id: 'a'.repeat(22),
      method: 'm',
      params: {},
      laterField: { executionHost: 'runtime:a' }
    }
    const read = readBridgeClientMessage(JSON.stringify(frame))
    expect(read).toEqual({
      ok: true,
      message: {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'request',
        id: 'a'.repeat(22),
        method: 'm',
        params: {}
      }
    })
  })
})
