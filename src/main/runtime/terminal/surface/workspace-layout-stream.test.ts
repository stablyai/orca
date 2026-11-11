import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  localDesktopSession,
  relaySshSession
} from '../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  SSH_KEY
} from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { WorkspaceLayoutStream } from './workspace-layout-stream'
import { collectLayoutEvents } from '../../orca-runtime-tests/workspace-layout-stream-events.test-fixture'

const SSH_HOST: ExecutionHostId = 'ssh:target-1'

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
})
