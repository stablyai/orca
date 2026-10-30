import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  localDesktopSession,
  relaySshSession,
  serverRuntimeSession
} from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  SERVER_KEY,
  SSH_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from './workspace-layout-stream-events.test-fixture'

const SSH_HOST: ExecutionHostId = 'ssh:target-1'
const SERVER_HOST: ExecutionHostId = 'runtime:env-1'

function fakeStore(partitions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const listeners = new Set<(hostId: ExecutionHostId | null) => void>()
  const onWorkspaceSessionWritten = vi.fn((listener: (hostId: ExecutionHostId | null) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  const getWorkspaceSession = vi.fn((hostId: ExecutionHostId) => partitions.get(hostId)!)
  return {
    store: {
      getWorkspaceSession,
      getWorkspaceSessionHostIds: () => [...partitions.keys()],
      onWorkspaceSessionWritten
    },
    listeners,
    write(hostId: ExecutionHostId, session: WorkspaceSessionState) {
      partitions.set(hostId, session)
      listeners.forEach((listener) => listener(hostId))
    },
    writeUnnamed(hostId: ExecutionHostId, session: WorkspaceSessionState) {
      partitions.set(hostId, session)
      listeners.forEach((listener) => listener(null))
    },
    removePartition(hostId: ExecutionHostId) {
      partitions.delete(hostId)
      listeners.forEach((listener) => listener(hostId))
    }
  }
}

/** Full uncached projection is the reference for partition-scoped updates. */
function fullProjection(
  partitions: Map<ExecutionHostId, WorkspaceSessionState>,
  homeHostId: (key: string) => ExecutionHostId | null
): [string, PublishedWorkspaceLayout][] {
  const projected = new Map<string, PublishedWorkspaceLayout>()
  for (const [hostId, session] of partitions) {
    const { layout } = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
    for (const [key, workspace] of Object.entries(layout.workspaces)) {
      if (homeHostId(key) === hostId) {
        projected.set(key, publishWorkspaceLayout(workspace, hostId))
      }
    }
  }
  return [...projected]
}

function setup() {
  const partitions = new Map<ExecutionHostId, WorkspaceSessionState>([
    [LOCAL_EXECUTION_HOST_ID, localDesktopSession()],
    [SSH_HOST, relaySshSession('target-1')]
  ])
  const fake = fakeStore(partitions)
  const homes: Record<string, ExecutionHostId> = {
    [GIT_KEY]: LOCAL_EXECUTION_HOST_ID,
    [FOLDER_KEY]: LOCAL_EXECUTION_HOST_ID,
    [SSH_KEY]: SSH_HOST
  }
  const liveTitles = new Map<string, string>()
  const liveTitle = vi.fn((ptyId: string) => liveTitles.get(ptyId) ?? null)
  const stream = new WorkspaceLayoutStream({
    store: () => fake.store,
    homeHostId: (key) => homes[key] ?? null,
    liveTitle
  })
  return { ...fake, stream, homes, partitions, liveTitles, liveTitle }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function subscribeEvents(stream: WorkspaceLayoutStream) {
  const collector = collectLayoutEvents()
  const subscription = stream.subscribe(collector.listener)
  collector.seed(subscription.snapshot)
  return { events: collector.events, collector, subscription }
}

describe('WorkspaceLayoutStream', () => {
  it('does nothing until someone subscribes, and stops when the last one leaves', () => {
    const { stream, store, listeners } = setup()
    expect(store.onWorkspaceSessionWritten).not.toHaveBeenCalled()
    const first = stream.subscribe(() => {})
    const second = stream.subscribe(() => {})
    expect(listeners.size).toBe(1)
    first.unsubscribe()
    expect(listeners.size).toBe(1)
    second.unsubscribe()
    expect(listeners.size).toBe(0)
  })

  it('snapshots each workspace from its owning partition only', () => {
    const { stream, homes } = setup()
    const { snapshot } = stream.subscribe(() => {})
    const hostOf = (entry: (typeof snapshot)[number]) => entry.layout.tabs[0]?.executionHostId
    expect(snapshot.map((entry) => [entry.key, hostOf(entry)])).toEqual([
      [GIT_KEY, LOCAL_EXECUTION_HOST_ID],
      [FOLDER_KEY, LOCAL_EXECUTION_HOST_ID],
      [SSH_KEY, SSH_HOST]
    ])
    // A non-owning partition's stray copy must not publish.
    homes[SSH_KEY] = LOCAL_EXECUTION_HOST_ID
    const strayless = new WorkspaceLayoutStream({
      store: () => setup().store,
      homeHostId: (key) => homes[key] ?? null,
      liveTitle: () => null
    }).subscribe(() => {}).snapshot
    expect(strayless.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
  })

  it('publishes a workspace when a write changes it by value, and its removal', async () => {
    const { stream, write } = setup()
    const { events } = subscribeEvents(stream)
    const session = localDesktopSession()
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(events).toEqual([])

    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, session)
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(events.map((event) => [event.type, event.key])).toEqual([['workspace', GIT_KEY]])

    const withoutFolder = structuredClone(session)
    delete withoutFolder.tabsByWorktree[FOLDER_KEY]
    delete withoutFolder.unifiedTabs![FOLDER_KEY]
    delete withoutFolder.tabGroups![FOLDER_KEY]
    delete withoutFolder.tabGroupLayouts![FOLDER_KEY]
    write(LOCAL_EXECUTION_HOST_ID, withoutFolder)
    await flush()
    expect(events.at(-1)).toEqual({ type: 'removed', key: FOLDER_KEY, seq: events[0]!.seq! + 1 })
  })

  it("publishes nothing for a pane's grid, which is main's own record", async () => {
    const { stream, write } = setup()
    const { events } = subscribeEvents(stream)
    const session = localDesktopSession()
    const [tabId, layout] = Object.entries(session.terminalLayoutsByTabId).find(
      ([, candidate]) => candidate.root?.type === 'leaf'
    )!
    const leafId = layout.root!.type === 'leaf' ? layout.root!.leafId : ''
    layout.lastGridsByLeafId = { [leafId]: { cols: 91, rows: 33 } }
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(session.terminalLayoutsByTabId[tabId]?.lastGridsByLeafId).toBeDefined()
    expect(events).toEqual([])
  })

  it('numbers each change frame, so a reply can name the frame holding its write', async () => {
    const { stream, write } = setup()
    const { events, subscription: first } = subscribeEvents(stream)
    const session = localDesktopSession()
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(events).toEqual([])
    expect(stream.settledSeq()).toBe(first.seq)

    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, session)
    // Read before the queued flush runs: the write's frame goes out first.
    const replySeq = stream.settledSeq()
    expect(events).toEqual([expect.objectContaining({ key: GIT_KEY, seq: first.seq + 1 })])
    expect(replySeq).toBe(first.seq + 1)
    await flush()
    expect(events).toHaveLength(1)

    first.unsubscribe()
    const second = stream.subscribe(() => {})
    expect(second.seq).toBeGreaterThanOrEqual(replySeq)
    second.unsubscribe()
  })

  it('logs a failing listener once and never throws into the write', async () => {
    const { stream, write } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stream.subscribe(() => {
      throw new Error('listener failed')
    })
    const session = localDesktopSession()
    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    expect(() => write(LOCAL_EXECUTION_HOST_ID, session)).not.toThrow()
    await flush()
    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, structuredClone(session))
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('keeps delivering to every listener when one throws', async () => {
    const { stream, write } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stream.subscribe(() => {
      throw new Error('listener failed')
    })
    const { events } = subscribeEvents(stream)
    const session = localDesktopSession()
    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(events.map((event) => [event.type, event.key])).toEqual([['workspace', GIT_KEY]])
    write(LOCAL_EXECUTION_HOST_ID, structuredClone(session))
    await flush()
    expect(events).toHaveLength(1)
    warn.mockRestore()
  })

  it('keeps every invented id when an earlier workspace or tab goes away', async () => {
    // Headless rows without tab-bar or pane layout require synthesized groups and panes.
    const rowsOnly = (keys: string[], tabs: string[]): WorkspaceSessionState => {
      const session = emptySession()
      for (const key of keys) {
        session.tabsByWorktree[key] = tabs.map((tab, index) => ({
          id: `${key}-${tab}`,
          ptyId: null,
          worktreeId: key,
          title: tab,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: Number(tab.slice(1))
        }))
      }
      return session
    }
    const keys = ['repo-1::/a', 'repo-1::/b', 'repo-1::/c']
    const fake = fakeStore(new Map([[LOCAL_EXECUTION_HOST_ID, rowsOnly(keys, ['t1', 't2'])]]))
    const stream = new WorkspaceLayoutStream({
      store: () => fake.store,
      homeHostId: () => LOCAL_EXECUTION_HOST_ID,
      liveTitle: () => null
    })
    const { events, subscription } = subscribeEvents(stream)
    const before = new Map(
      subscription.snapshot.map((entry) => [entry.key, JSON.stringify(entry.layout)])
    )
    fake.write(LOCAL_EXECUTION_HOST_ID, rowsOnly(keys.slice(1), ['t1', 't2']))
    await flush()
    expect(events).toEqual([{ type: 'removed', key: 'repo-1::/a', seq: expect.any(Number) }])

    const withoutFirstTab = rowsOnly(keys.slice(1), ['t2'])
    fake.write(LOCAL_EXECUTION_HOST_ID, withoutFirstTab)
    await flush()
    const after = new Map(
      events.flatMap((event) => (event.type === 'workspace' ? [[event.key, event.layout]] : []))
    )
    for (const key of keys.slice(1)) {
      const earlier = JSON.parse(before.get(key)!)
      const later = after.get(key)!
      expect(later.groups.map((group) => group.id)).toEqual(
        earlier.groups.map((group: { id: string }) => group.id)
      )
      expect(JSON.stringify(later.tabs)).toBe(JSON.stringify(earlier.tabs.slice(1)))
    }
  })

  it('re-projects only the partition a write names', async () => {
    const { stream, store, write, writeUnnamed } = setup()
    stream.subscribe(() => {})
    store.getWorkspaceSession.mockClear()
    write(SSH_HOST, relaySshSession('target-1'))
    await flush()
    expect(store.getWorkspaceSession.mock.calls).toEqual([[SSH_HOST]])
    store.getWorkspaceSession.mockClear()
    writeUnnamed(SSH_HOST, relaySshSession('target-1'))
    await flush()
    expect(store.getWorkspaceSession.mock.calls).toEqual([[LOCAL_EXECUTION_HOST_ID], [SSH_HOST]])
  })

  it('publishes what a full re-projection with the load report would, write after write', async () => {
    const { stream, write, writeUnnamed, removePartition, homes, partitions } = setup()
    const homeHostId = (key: string) => homes[key] ?? null
    const { collector } = subscribeEvents(stream)
    const expectFullProjection = async (): Promise<void> => {
      await flush()
      const expected = fullProjection(partitions, homeHostId)
      expect(Object.fromEntries(collector.layouts)).toEqual(Object.fromEntries(expected))
      const late = stream.subscribe(() => {})
      expect(late.snapshot.map((entry) => [entry.key, entry.layout])).toEqual(expected)
      late.unsubscribe()
    }
    await expectFullProjection()

    const local = localDesktopSession()
    local.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, local)
    await expectFullProjection()

    // A named write and an unnamed one in the same task.
    const ssh = relaySshSession('target-1')
    delete ssh.tabsByWorktree[SSH_KEY]
    delete ssh.unifiedTabs![SSH_KEY]
    write(SSH_HOST, ssh)
    writeUnnamed(LOCAL_EXECUTION_HOST_ID, localDesktopSession())
    await expectFullProjection()

    // A new partition, a home that moves between partitions, then the partition removed.
    homes[SERVER_KEY] = SERVER_HOST
    write(SERVER_HOST, serverRuntimeSession('env-1'))
    await expectFullProjection()
    homes[GIT_KEY] = SERVER_HOST
    write(SSH_HOST, relaySshSession('target-1'))
    await expectFullProjection()
    homes[GIT_KEY] = LOCAL_EXECUTION_HOST_ID
    removePartition(SERVER_HOST)
    await expectFullProjection()
  })

  it('re-projects every partition after a failed projection', async () => {
    const { stream, store, write } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { events } = subscribeEvents(stream)
    store.getWorkspaceSession.mockImplementationOnce(() => {
      throw new Error('read failed')
    })
    const local = localDesktopSession()
    local.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, local)
    await flush()
    expect(events).toEqual([])
    // A later write elsewhere must recover the local edit missed by the failed projection.
    write(SSH_HOST, relaySshSession('target-1'))
    await flush()
    expect(events.map((event) => [event.type, event.key])).toEqual([['workspace', GIT_KEY]])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  describe('live pane titles', () => {
    const panesOf = (layout: PublishedWorkspaceLayout) =>
      layout.tabs.flatMap((tab) => tab.terminal?.panes ?? [])
    const ptyIdsOf = (layout: PublishedWorkspaceLayout) =>
      panesOf(layout).flatMap((pane) => (pane.ptyId ? [pane.ptyId] : []))

    it('lays each pane terminal title over its pane, and only there', () => {
      const { stream, liveTitles } = setup()
      const bare = stream.subscribe(() => {}).snapshot
      const [first, second] = ptyIdsOf(bare.find((entry) => entry.key === GIT_KEY)!.layout)
      liveTitles.set(first, 'claude: working')
      liveTitles.set(second, 'vim')
      const late = setup()
      late.liveTitles.set(first, 'claude: working')
      late.liveTitles.set(second, 'vim')
      const titled = late.stream.subscribe(() => {}).snapshot
      const git = titled.find((entry) => entry.key === GIT_KEY)!.layout
      const byPty = new Map(panesOf(git).map((pane) => [pane.ptyId, pane.liveTitle]))
      expect(byPty.get(first)).toBe('claude: working')
      expect(byPty.get(second)).toBe('vim')
      const stripped = titled.map((entry) => ({
        key: entry.key,
        layout: JSON.parse(
          JSON.stringify(entry.layout, (k, v) => (k === 'liveTitle' ? undefined : v))
        )
      }))
      expect(stripped).toEqual(bare)
    })

    it('publishes a title change without reading the Store, one frame per burst', async () => {
      const { stream, store, liveTitles, write } = setup()
      const {
        events,
        subscription: { snapshot }
      } = subscribeEvents(stream)
      const [ptyId] = ptyIdsOf(snapshot.find((entry) => entry.key === GIT_KEY)!.layout)
      store.getWorkspaceSession.mockClear()
      for (let frame = 0; frame < 50; frame++) {
        liveTitles.set(ptyId, `build ${frame}`)
        stream.markLiveTitlesDirty()
      }
      await flush()
      expect(store.getWorkspaceSession).not.toHaveBeenCalled()
      expect(events).toHaveLength(1)
      const event = events[0]
      expect(event.type === 'workspace' && event.key).toBe(GIT_KEY)
      expect(
        event.type === 'workspace' && panesOf(event.layout).find((p) => p.ptyId === ptyId)
      ).toMatchObject({ liveTitle: 'build 49' })

      // An unchanged title sends nothing; a structural write keeps the title on.
      stream.markLiveTitlesDirty()
      await flush()
      expect(events).toHaveLength(1)
      const session = localDesktopSession()
      session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
      write(LOCAL_EXECUTION_HOST_ID, session)
      await flush()
      const rewritten = events.at(-1)!
      expect(
        rewritten.type === 'workspace' && panesOf(rewritten.layout).find((p) => p.ptyId === ptyId)
      ).toMatchObject({ liveTitle: 'build 49' })

      liveTitles.delete(ptyId)
      stream.markLiveTitlesDirty()
      await flush()
      const cleared = events.at(-1)!
      expect(cleared.type === 'workspace' && panesOf(cleared.layout).some((p) => p.liveTitle)).toBe(
        false
      )
    })

    it('reads no title while nobody subscribes', async () => {
      const { stream, liveTitle } = setup()
      stream.markLiveTitlesDirty()
      await flush()
      expect(liveTitle).not.toHaveBeenCalled()
      stream.subscribe(() => {}).unsubscribe()
      liveTitle.mockClear()
      stream.markLiveTitlesDirty()
      await flush()
      expect(liveTitle).not.toHaveBeenCalled()
    })
  })
})
