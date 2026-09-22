import { describe, expect, it } from 'vitest'
import {
  BRIDGE_PAGE_CLIENT_ID,
  BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT,
  substituteBridgePageClientIdentity
} from './bridge-page-client-identity'
import { HARNESS_CLIENT_IDENTITY, harness, ID, OTHER } from '../bridge-host-test-harness'
import { bridgeId, clientFrame } from '../bridge-host-test-fakes'

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

  it('drops the field rather than forwarding a placeholder the shell cannot resolve', () => {
    // The host reads a missing `client` as a pre-identity mobile caller, which is a degradation.
    // The placeholder would be a refusal, and it is the one outcome this seam must never produce.
    expect(
      substituteBridgePageClientIdentity(
        { terminal: 'pty-1', client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' } },
        null
      )
    ).toEqual({ terminal: 'pty-1' })
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

  it('serves a shell that cannot read the identity yet without leaking the placeholder', () => {
    const bridge = harness({ ready: true, clientIdentity: null })
    bridge.host.receive(identitySubscribe(ID))
    expect(bridge.client.streams[0]?.params).toEqual({
      terminal: 'pty-1',
      viewport: { cols: 80, rows: 24 }
    })
  })

  it('tells the page it performs the swap, on a list an older page ignores', () => {
    const bridge = harness({ ready: true })
    const init = bridge.frames().find((message) => message.type === 'init')
    expect(init?.accepts).toContain(BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT)
  })
})
