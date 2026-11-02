import { afterEach, describe, expect, it } from 'vitest'
import { BRIDGE_PAGE_CLIENT_ID } from './bridge-page-client-identity'
import { HARNESS_CLIENT_IDENTITY, harness, ID } from '../bridge-host-test-harness'
import { bridgeId, clientFrame } from '../bridge-host-test-fakes'
import {
  createFakeBridgePortPair as createPair,
  PORT_PAIR_CLIENT_IDENTITY
} from './bridge-port-pair-test-harness'

const resources = new Set<ReturnType<typeof createPair>>()
function createFakeBridgePortPair(
  ...args: Parameters<typeof createPair>
): ReturnType<typeof createPair> {
  const resource = createPair(...args)
  resources.add(resource)
  return resource
}
function closeResources(): void {
  for (const resource of resources) {
    resource.client.close()
    resource.host.dispose()
  }
  resources.clear()
}

// Resolve device identity on requests and subscriptions: terminal.send compares client.id with the socket’s authenticated credential, which the page must never hold.

const identitySubscribe = (id: string) =>
  clientFrame({
    type: 'subscribe',
    id,
    method: 'terminal.subscribe',
    params: {
      terminal: 'pty-1',
      client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile', label: 'page' },
      mobileClient: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile', label: 'second' },
      viewport: { cols: 80, rows: 24 }
    }
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
          client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile', label: 'page' },
          mobileClient: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile', label: 'second' }
        }
      })
    )
    expect(bridge.client.requests[0]?.args[1]).toEqual({
      terminal: 'pty-1',
      text: '\u001b[3;4R',
      inputKind: 'query-reply',
      client: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile', label: 'page' },
      mobileClient: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile', label: 'second' }
    })

    const controls = [
      {
        terminal: 'pty-2',
        client: { id: 'somebody-else', type: 'mobile' },
        mobileClient: { id: 'other-device', label: 'untouched' }
      },
      { terminal: 'pty-3' },
      null,
      [{ client: { id: BRIDGE_PAGE_CLIENT_ID } }]
    ]
    controls.forEach((params, index) =>
      bridge.host.receive(
        clientFrame({ type: 'request', id: bridgeId(index + 3), method: 'terminal.send', params })
      )
    )
    expect(bridge.client.requests.slice(1).map(({ args }) => args)).toEqual(
      controls.map((params) => ['terminal.send', params])
    )
  })

  it('on a stream start, which is where terminal.subscribe leaves', () => {
    const bridge = harness({ ready: true })
    bridge.host.receive(identitySubscribe(ID))
    expect(bridge.client.streams[0]?.params).toEqual({
      terminal: 'pty-1',
      client: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile', label: 'page' },
      mobileClient: { id: HARNESS_CLIENT_IDENTITY, type: 'mobile', label: 'second' },
      viewport: { cols: 80, rows: 24 }
    })
    const params = {
      terminal: 'pty-2',
      client: { id: 'somebody-else', type: 'mobile' },
      mobileClient: { id: 'other-device', label: 'untouched' }
    }
    bridge.host.receive(
      clientFrame({ type: 'subscribe', id: bridgeId(8), method: 'terminal.subscribe', params })
    )
    expect(bridge.client.streams[1]?.params).toEqual(params)
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
    expect(bridge.last()).toMatchObject({
      type: 'error',
      id: ID,
      error: {
        category: 'BridgePageClientIdentityUnavailableError',
        code: 'bridge_client_identity_unavailable'
      }
    })

    bridge.host.receive(clientFrame({ type: 'request', id: bridgeId(9), method: 'status.get' }))
    expect(bridge.client.requests.map(({ args }) => args)).toEqual([['status.get']])
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

    // Reject locally when identity cannot resolve; the composer must not believe a send made under a different caller.
    expect(await settled).toMatchObject({ code: 'bridge_client_identity_unavailable' })
    expect(pair.rpc.requests).toHaveLength(0)

    // Prove the same call forwards with valid identity so the zero-send assertion cannot pass on a broken pair.
    const served = createFakeBridgePortPair()
    await served.flush()
    void served.client
      .sendRequest('terminal.send', {
        terminal: 'pty-1',
        text: 'ls',
        client: { id: BRIDGE_PAGE_CLIENT_ID, type: 'mobile' }
      })
      .catch(() => undefined)
    await served.flush()
    expect(served.rpc.requests).toHaveLength(1)
    expect(served.rpc.requests[0]?.args[1]).toMatchObject({
      client: { id: PORT_PAIR_CLIENT_IDENTITY, type: 'mobile' }
    })
  })
})

afterEach(closeResources)
