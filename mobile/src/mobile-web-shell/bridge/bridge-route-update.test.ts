import { describe, expect, it } from 'vitest'
import { createFakeBridgePortPair } from './bridge-port-pair-test-harness'
import type { BridgeInitRoute } from './bridge-envelope'

const SESSION = '/h/host-a/session/wt-1'

/** The route the session switch hands the shell, with the tap's pane key on it or without. */
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

/** Every pane key the page was told about, in order, including the clears. */
function recordRouteUpdates(pair: ReturnType<typeof createFakeBridgePortPair>): string[] {
  const seen: string[] = []
  pair.client.onRouteUpdate((route) => {
    seen.push(route?.params?.paneKey ?? '')
  })
  return seen
}

/**
 * A notification tap for a pane of the session already on screen (ruling 33.1).
 *
 * The tap rewrites one param of a route the page is already mounted on, and neither half of what
 * the shell had could carry it: keying the screen on the whole route made a pane change a remount
 * and a repeat tap nothing at all. The pane request travels as a re-sent `init` instead, which is
 * a frame both sides already have, and the page reads a second `init` for its own session as a
 * route update rather than as a replacement.
 */
describe('a route update over a re-sent init', () => {
  it('reaches the page twice for a repeat tap on the same pane', async () => {
    const pair = await openedOnTheSession()
    const seen = recordRouteUpdates(pair)
    pair.host.publishRoute(sessionRoute('pane-1'))
    await pair.flush()
    // What the native switch does after posting, so a later `init` cannot replay a spent tap.
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
    // The page never re-handshook, so nothing it holds was torn down and rebuilt.
    expect(pair.pageReadyCount()).toBe(1)
    expect(pair.client.getShellSession()?.sessionId).toBe(before?.sessionId)
  })

  /**
   * A re-asked `ready` is not a route update (round 2).
   *
   * The page re-asks on its backoff and again after a refused `state` frame, and the shell answers
   * every ask with the route it holds. Publishing those as updates made the pane hook see the
   * route it was already on — `['', 'pane-1']` for one tap — so the listener fires only when the
   * params have actually moved.
   */
  it('publishes nothing for a re-asked ready that carries the route the page holds', async () => {
    const pair = await openedOnTheSession()
    const seen = recordRouteUpdates(pair)
    pair.host.receive(JSON.stringify({ v: 1, type: 'ready' }))
    await pair.flush()
    expect(seen).toEqual([])
    // And the same ask after a real update still leaves exactly the one delivery behind it.
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
