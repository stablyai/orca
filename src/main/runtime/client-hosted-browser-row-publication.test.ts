import { describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

function publishPage(
  registry: RuntimeBrowserPageRegistry,
  browserPageId: string,
  workspaceId: string
): void {
  registry.publishClientPage({
    browserPageId,
    workspaceId,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7',
    placement: {
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    },
    pairedDeviceId: 'device-a',
    url: `https://example.test/${browserPageId}`,
    loading: false,
    active: false
  })
}

function createPublisher(): {
  publisher: ClientHostedBrowserRowPublisher
  registry: RuntimeBrowserPageRegistry
  listClientPages: ReturnType<typeof vi.fn>
  events: ClientHostedBrowserRowsEvent[]
  livePlacements: Set<string>
  detach(): void
  attach(): void
} {
  const registry = new RuntimeBrowserPageRegistry()
  const listClientPages = vi.fn((worktreeId?: string) => registry.listPages(worktreeId))
  const events: ClientHostedBrowserRowsEvent[] = []
  const livePlacements = new Set<string>()
  let attached = true
  const publisher = new ClientHostedBrowserRowPublisher({
    listClientPages,
    hasLivePlacement: (browserPageId) => livePlacements.has(browserPageId),
    resolveDeviceName: () => 'Studio',
    getEmitter: () =>
      attached
        ? (event): void => {
            events.push(event)
          }
        : null
  })
  return {
    publisher,
    registry,
    listClientPages,
    events,
    livePlacements,
    detach: () => {
      attached = false
    },
    attach: () => {
      attached = true
    }
  }
}

describe('ClientHostedBrowserRowPublisher', () => {
  it('pushes the workspace rows once a client page exists', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')

    publisher.publish('wt-1')

    expect(events).toEqual([
      {
        worktreeId: 'wt-1',
        rows: [
          {
            browserPageId: 'page-1',
            worktreeId: 'wt-1',
            url: 'https://example.test/page-1',
            title: 'Browser',
            loading: false,
            browserHostClientId: 'host-a',
            hostDeviceName: 'Studio',
            hostAbsent: false
          }
        ]
      }
    ])
  })

  it('stays silent for a workspace that never had a client page', () => {
    const { publisher, events } = createPublisher()

    publisher.publish('wt-1')
    publisher.publish('wt-1')

    expect(events).toEqual([])
  })

  it('pushes the emptied list exactly once after the last page goes', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')
    events.length = 0

    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    publisher.publish('wt-1')
    publisher.publish('wt-1')

    expect(events).toEqual([{ worktreeId: 'wt-1', rows: [] }])
  })

  it('re-announces a workspace that gains a page again after emptying', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')
    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    publisher.publish('wt-1')
    events.length = 0

    publishPage(registry, 'page-2', 'wt-1')
    livePlacements.add('page-2')
    publisher.publish('wt-1')

    expect(events.map((event) => event.rows.map((row) => row.browserPageId))).toEqual([['page-2']])
  })

  it('flips a row to host-absent when its lease is gone', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')
    events.length = 0

    livePlacements.delete('page-1')
    publisher.publish('wt-1')

    expect(events).toEqual([
      { worktreeId: 'wt-1', rows: [expect.objectContaining({ hostAbsent: true })] }
    ])
  })

  it('publishes every workspace holding client pages when no workspace is named', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    publishPage(registry, 'page-2', 'wt-2')
    livePlacements.add('page-1')
    livePlacements.add('page-2')

    publisher.publishAll()

    expect(events.map((event) => event.worktreeId).sort()).toEqual(['wt-1', 'wt-2'])
  })

  // A single inventory scan avoids one extra scan per workspace.
  it('scans the registry once when publishing all workspaces', () => {
    const { publisher, registry, events, livePlacements, listClientPages } = createPublisher()
    const worktreeIds = Array.from({ length: 64 }, (_, index) => `wt-${index}`)
    for (const [index, worktreeId] of worktreeIds.entries()) {
      const browserPageId = `page-${index}`
      publishPage(registry, browserPageId, worktreeId)
      livePlacements.add(browserPageId)
    }

    publisher.publishAll()

    expect(listClientPages).toHaveBeenCalledTimes(1)
    expect(listClientPages).toHaveBeenCalledWith()
    expect(events.map((event) => event.worktreeId)).toEqual(worktreeIds)
    expect(events).toHaveLength(worktreeIds.length)
    for (const [index, event] of events.entries()) {
      expect(event.rows).toHaveLength(1)
      expect(event.rows[0]).toMatchObject({
        browserPageId: `page-${index}`,
        worktreeId: worktreeIds[index]
      })
    }
  })

  it('retracts a previously published workspace on a bare republish', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')
    events.length = 0

    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    publisher.publishAll()

    expect(events).toEqual([{ worktreeId: 'wt-1', rows: [] }])
  })

  it('replays a workspace whose only publish landed while no renderer was attached', () => {
    const { publisher, registry, events, livePlacements, attach, detach } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')

    detach()
    publisher.publish('wt-1')
    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    attach()
    publisher.publish('wt-1')

    expect(events).toEqual([])
    expect(publisher.deliverHydrationSnapshot()).toEqual([])
  })

  it('snapshots every workspace with client pages for renderer hydration', () => {
    const { publisher, registry, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    publishPage(registry, 'page-2', 'wt-2')
    livePlacements.add('page-1')

    expect(
      publisher
        .deliverHydrationSnapshot()
        .map((event) => event.worktreeId)
        .sort()
    ).toEqual(['wt-1', 'wt-2'])
  })

  // Track every hydrated workspace: only retracting the second reveals a first-workspace-only bug.
  it('records every workspace the hydration snapshot carries, not just the first', () => {
    const { publisher, registry, events, livePlacements } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    publishPage(registry, 'page-2', 'wt-2')
    livePlacements.add('page-1')
    livePlacements.add('page-2')

    expect(publisher.deliverHydrationSnapshot()).toHaveLength(2)
    events.length = 0

    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    registry.retirePage('page-2', registry.getPage('page-2')!.placement)
    publisher.publish('wt-1')
    publisher.publish('wt-2')

    expect(events).toEqual([
      { worktreeId: 'wt-1', rows: [] },
      { worktreeId: 'wt-2', rows: [] }
    ])
  })

  it('snapshots nothing when no client page exists', () => {
    const { publisher } = createPublisher()

    expect(publisher.deliverHydrationSnapshot()).toEqual([])
  })

  // Hydration is delivery; untracked hydrated rows would become unretractable ghosts.
  it('retracts a row the renderer received only through hydration', () => {
    const { publisher, registry, events, livePlacements, attach, detach } = createPublisher()
    detach()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')

    attach()
    expect(publisher.deliverHydrationSnapshot()).toEqual([
      { worktreeId: 'wt-1', rows: [expect.objectContaining({ browserPageId: 'page-1' })] }
    ])
    events.length = 0

    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    publisher.publish('wt-1')

    expect(events).toEqual([{ worktreeId: 'wt-1', rows: [] }])
  })

  // Nonempty replacement distinguishes exact delivered membership from clear-only or union behavior.
  it('tracks exactly the workspaces a non-empty hydration snapshot carries', () => {
    const { publisher, registry, events, livePlacements, attach, detach } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')

    detach()
    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    publishPage(registry, 'page-2', 'wt-2')
    livePlacements.add('page-2')
    attach()
    expect(publisher.deliverHydrationSnapshot().map((event) => event.worktreeId)).toEqual(['wt-2'])
    events.length = 0

    publisher.publish('wt-1')
    registry.retirePage('page-2', registry.getPage('page-2')!.placement)
    publisher.publish('wt-2')

    expect(events).toEqual([{ worktreeId: 'wt-2', rows: [] }])
  })

  it('stops tracking a workspace the hydration snapshot no longer carries', () => {
    const { publisher, registry, events, livePlacements, attach, detach } = createPublisher()
    publishPage(registry, 'page-1', 'wt-1')
    livePlacements.add('page-1')
    publisher.publish('wt-1')

    detach()
    registry.retirePage('page-1', registry.getPage('page-1')!.placement)
    attach()
    expect(publisher.deliverHydrationSnapshot()).toEqual([])
    events.length = 0

    publisher.publish('wt-1')

    expect(events).toEqual([])
  })
})
