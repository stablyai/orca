import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import type { BridgeInitRoute } from './bridge-envelope'

const SESSION = '/h/host-a/session/wt-1'

function sessionRoute(paneKey?: string): BridgeInitRoute {
  return {
    pathname: SESSION,
    params: { name: 'my worktree', ...(paneKey === undefined ? {} : { paneKey }) }
  }
}

async function openedOnTheSession(): Promise<ReturnType<typeof createFakeBridgePortPair>> {
  const pair = createFakeBridgePortPair({
    route: sessionRoute(),
    storage: { 'orca:hostDockWidth': '320' }
  })
  await pair.flush()
  return pair
}

function recordRouteUpdates(pair: ReturnType<typeof createFakeBridgePortPair>): string[] {
  const seen: string[] = []
  pair.client.onRouteUpdate((route) => {
    seen.push(route?.params?.paneKey ?? '')
  })
  return seen
}

// Deliver pane taps through same-session init updates so the mounted page keeps its state; remount keys exclude pane params (ruling 33.1).
describe('a route update over a re-sent init', () => {
  it('reaches the page twice for a repeat tap on the same pane', async () => {
    const pair = await openedOnTheSession()
    const seen = recordRouteUpdates(pair)
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    pair.host.publishRoute(sessionRoute())
    await pair.flush()
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    expect(seen).toEqual(['pane-1', '', 'pane-1'])
  })

  it('reaches the page for a different pane without opening a second session', async () => {
    const pair = await openedOnTheSession()
    const before = pair.client.getShellSession()
    const seen = recordRouteUpdates(pair)
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    pair.host.publishRoute(sessionRoute('pane-2'))
    await pair.flush()
    expect(seen).toEqual(['pane-1', 'pane-2'])
    expect(pair.pageReadyCount()).toBe(1)
    expect(pair.client.getShellSession()?.sessionId).toBe(before?.sessionId)
  })

  // Repeated ready repairs state but is not another pane request; notify listeners only when route params move.
  it('publishes nothing for a re-asked ready that carries the route the page holds', async () => {
    const pair = await openedOnTheSession()
    const seen = recordRouteUpdates(pair)
    pair.host.receive(JSON.stringify({ v: 1, type: 'ready' }))
    await pair.flush()
    expect(seen).toEqual([])
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    pair.host.receive(JSON.stringify({ v: 1, type: 'ready' }))
    await pair.flush()
    expect(seen).toEqual(['pane-1'])
  })

  it('leaves a request pending across the update still resolving', async () => {
    const pair = await openedOnTheSession()
    const pending = pair.client.sendRequest('worktree.list')
    await pair.flush()
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    const sent = pair.rpc.requests.find((request) => request.method === 'worktree.list')
    sent?.resolve({ id: 'r1', ok: true, result: { worktrees: [] } })
    await pair.flush()
    await expect(pending).resolves.toMatchObject({ ok: true })
  })

  it('leaves the storage snapshot the same object the page already held', async () => {
    const pair = await openedOnTheSession()
    const before = pair.client.getShellSession()?.storage
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    expect(pair.client.getShellSession()?.storage).toBe(before)
  })

  it('sends the second init to a page whose ready declares nothing', async () => {
    const pair = await openedOnTheSession()
    pair.host.receive(JSON.stringify({ v: 1, type: 'ready' }))
    await pair.flush()
    const framesBefore = pair.toPage.length
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    expect(pair.toPage.length).toBe(framesBefore + 1)
  })
})
