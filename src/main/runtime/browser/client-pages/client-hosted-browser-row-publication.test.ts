import { describe, expect, it, vi } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../../../shared/client-hosted-browser-rows'
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
  // A single inventory scan avoids one extra scan per workspace.

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

  // Track every hydrated workspace: only retracting the second reveals a first-workspace-only bug.

  // Hydration is delivery; untracked hydrated rows would become unretractable ghosts.

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
})
