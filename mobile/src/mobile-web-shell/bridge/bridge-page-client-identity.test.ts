import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PAGE_CLIENT_ID,
  BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT,
  BridgePageClientIdentityUnavailableError,
  substituteBridgePageClientIdentity
} from './bridge-page-client-identity'
import { HARNESS_CLIENT_IDENTITY, harness, ID, OTHER } from '../bridge-host-test-harness'
import { bridgeId, clientFrame } from '../bridge-host-test-fakes'
import {
  createFakeBridgePortPair,
  PORT_PAIR_CLIENT_IDENTITY
} from './bridge-port-pair-test-harness'

/**
 * The swap, and the two doors it has to cover.
 *
 * A page's `client.id` is not an opaque key to the host: `terminal.send` refuses a query reply
 * whose id is not the credential the socket authenticated with, which the host's own
 * "rejects query replies that spoof a different authenticated mobile client" pins. So what leaves
 * the shell must be the device's identity, and the page must never hold it.
 */

/** A `terminal.subscribe` exactly as the page posts one, placeholder included. */
const identitySubscribe = (id: string) =>
  clientFrame({
    type: 'subscribe',
    id,
    method: 'terminal.subscribe',
    params: {
      terminal: 'pty-1',
      client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' },
      viewport: { cols: 80, rows: 24 }
    }
  })

describe('the placeholder a page claims', () => {
  it('is a fixed string, so a resent message fingerprints the same caller after a remount', () => {
    // The composer's send journal refuses a retained operation whose caller changed, and it has no
    // expiry. A per-document identity would turn "send it again" into a permanent refusal.
    expect(BRIDGE_PAGE_CLIENT_ID).toBe('orca-page-client')
    expect(BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT).toBe('page-client-identity')
  })

  it('becomes the device identity in both fields a page carries one in', () => {
    expect(
      substituteBridgePageClientIdentity(
        {
          terminal: 'pty-1',
          client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' },
          mobileClient: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' }
        },
        'device-token-a'
      )
    ).toEqual({
      terminal: 'pty-1',
      client: { id: 'device-token-a', type: 'mobile' },
      mobileClient: { id: 'device-token-a', type: 'mobile' }
    })
  })

  it('leaves an id that is not the placeholder alone', () => {
    // A native shell forwards what the caller sent. The host decides whether that id may speak for
    // this socket, and a shell that rewrote every id would hide a real spoof from it.
    const params = { terminal: 'pty-1', client: { id: 'somebody-else', type: 'mobile' } }
    expect(substituteBridgePageClientIdentity(params, 'device-token-a')).toBe(params)
  })

  it('replays params that claim nothing byte-exact, by identity', () => {
    // Same object back, not an equal one: the golden recorder reads the arity and the value the
    // client was called with, and a rebuilt object would move a recording that has not changed.
    const params = { terminal: 'pty-1', viewport: { cols: 80, rows: 24 } }
    expect(substituteBridgePageClientIdentity(params, 'device-token-a')).toBe(params)
    expect(substituteBridgePageClientIdentity(undefined, 'device-token-a')).toBe(undefined)
    expect(substituteBridgePageClientIdentity(null, 'device-token-a')).toBe(null)
    const list = [{ client: { id: BRIDGE_PAGE_CLIENT_ID } }]
    expect(substituteBridgePageClientIdentity(list, 'device-token-a')).toBe(list)
  })

  it('refuses a placeholder the shell cannot resolve rather than reshaping the call', () => {
    // Stripping the field would forward a request the page did not make: the host reads a missing
    // `client` as a different caller, so a shell-state bug would land as a silent degradation.
    expect(() =>
      substituteBridgePageClientIdentity(
        { terminal: 'pty-1', client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' } },
        null
      )
    ).toThrow(BridgePageClientIdentityUnavailableError)
  })

  it('lets a call that claims nothing through on a shell with no identity', () => {
    const params = { terminal: 'pty-1', viewport: { cols: 80, rows: 24 } }
    expect(substituteBridgePageClientIdentity(params, null)).toBe(params)
  })
})

describe('the shell substitutes on both doors to the client', () => {
  it('on a request, which is where terminal.send leaves', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: ID,
        method: 'terminal.send',
        params: {
          terminal: 'pty-1',
          text: '\u001b[3;4R',
          inputKind: 'query-reply',
          client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' }
        }
      })
    )
    // Equal to what the socket authenticated with, which is the whole point: this is the string the
    // host compares `params.client.id` against before it accepts a query reply.
    expect(bridge.client.requests[0]?.args[1]).toEqual({
      terminal: 'pty-1',
      text: '\u001b[3;4R',
      inputKind: 'query-reply',
      client: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile' }
    })
  })

  it('on a stream start, which is where terminal.subscribe leaves', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(identitySubscribe(ID))
    expect(bridge.client.streams[0]?.params).toEqual({
      terminal: 'pty-1',
      client: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile' },
      viewport: { cols: 80, rows: 24 }
    })
  })

  it('forwards the arity the page used, unchanged, when nothing claims the placeholder', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(clientFrame({ type: 'request', id: ID, method: 'status.get' }))
    bridge.host.receive(
      clientFrame({ type: 'request', id: OTHER, method: 'status.get', params: { a: 1 } })
    )
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: bridgeId(3),
        method: 'status.get',
        options: { timeoutMs: 50 }
      })
    )
    expect(bridge.client.requests.map((request) => request.args)).toEqual([
      ['status.get'],
      ['status.get', { a: 1 }],
      ['status.get', undefined, { timeoutMs: 50 }]
    ])
  })

  it('refuses a stream start when the shell has no identity, opening none', () => {
    const bridge = harness({ ready: true, clientIdentity: null })
    bridge.host.receive(identitySubscribe(ID))
    expect(bridge.client.streams).toHaveLength(0)
    expect(bridge.last()).toMatchObject({
      type: 'error',
      id: ID,
      error: { code: 'bridge_client_identity_unavailable' }
    })
  })

  it('refuses a request when the shell has no identity, sending none', () => {
    const bridge = harness({ ready: true, clientIdentity: null })
    bridge.host.receive(
      clientFrame({
        type: 'request',
        id: ID,
        method: 'terminal.send',
        params: { terminal: 'pty-1', client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' } }
      })
    )
    expect(bridge.client.requests).toHaveLength(0)
    // An ordinary error frame, which is what the page's client rejects its own call with: the
    // caller sees a failed RPC and not a send that quietly went out under another identity.
    expect(bridge.last()).toMatchObject({
      type: 'error',
      id: ID,
      error: {
        category: 'BridgePageClientIdentityUnavailableError',
        code: 'bridge_client_identity_unavailable'
      }
    })
  })

  it('tells the page it performs the swap, on a list an older page ignores', () => {
    const bridge = harness({ ready: true })
    const init = bridge.frames().find((message) => message.type === 'init')
    expect(init?.accepts).toContain(BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT)
  })
})

describe('what the page hears when the shell has no identity', () => {
  it("rejects the page's own call, as an ordinary RPC failure naming the reason", async () => {
    const pair = createFakeBridgePortPair({ clientIdentity: null })
    await pair.flush()

    const call = pair.client.sendRequest('terminal.send', {
      terminal: 'pty-1',
      text: 'ls',
      client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' }
    })
    const settled = call.then(
      () => null,
      (error: unknown) => error
    )
    await pair.flush()

    // The caller's promise rejects and nothing reached the desktop, so a composer that sent this
    // shows "not sent" rather than believing a send that went out under a different identity.
    expect(await settled).toMatchObject({ code: 'bridge_client_identity_unavailable' })
    expect(pair.rpc.requests).toHaveLength(0)

    // The precondition for that zero: the same call on a shell that has an identity does reach the
    // desktop, so nothing above is passing because this pair forwards nothing at all.
    const served = createFakeBridgePortPair()
    await served.flush()
    void served.client.sendRequest('terminal.send', {
      terminal: 'pty-1',
      text: 'ls',
      client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' }
    })
    await served.flush()
    expect(served.rpc.requests).toHaveLength(1)
    expect(served.rpc.requests[0]?.args[1]).toMatchObject({
      client: { id: PORT_PAIR_CLIENT_IDENTITY, type: 'mobile' }
    })
  })
})
