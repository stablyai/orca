import { describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  localDesktopSession,
  relaySshSession
} from '../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  emptySession,
  FOLDER_KEY,
  GIT_KEY,
  SSH_KEY
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { WorkspaceLayoutStream, type WorkspaceLayoutEvent } from './workspace-layout-stream'

const SSH_HOST: ExecutionHostId = 'ssh:target-1'

function fakeStore(partitions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const listeners = new Set<() => void>()
  const onWorkspaceSessionWritten = vi.fn((listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  })
  return {
    store: {
      getWorkspaceSession: (hostId: ExecutionHostId) => partitions.get(hostId)!,
      getWorkspaceSessionHostIds: () => [...partitions.keys()],
      onWorkspaceSessionWritten
    },
    listeners,
    write(hostId: ExecutionHostId, session: WorkspaceSessionState) {
      partitions.set(hostId, session)
      listeners.forEach((listener) => listener())
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
  const stream = new WorkspaceLayoutStream({
    store: () => fake.store,
    homeHostId: (key) => homes[key] ?? null
  })
  return { ...fake, stream, homes }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve))

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
    // Each workspace's tabs run on the partition that published it.
    const hostOf = (entry: (typeof snapshot)[number]) => entry.layout.tabs[0]?.executionHostId
    expect(snapshot.map((entry) => [entry.key, hostOf(entry)])).toEqual([
      [GIT_KEY, LOCAL_EXECUTION_HOST_ID],
      [FOLDER_KEY, LOCAL_EXECUTION_HOST_ID],
      [SSH_KEY, SSH_HOST]
    ])
    // A copy in a partition that does not own the workspace is a stray and is not shown.
    homes[SSH_KEY] = LOCAL_EXECUTION_HOST_ID
    const strayless = new WorkspaceLayoutStream({
      store: () => setup().store,
      homeHostId: (key) => homes[key] ?? null
    }).subscribe(() => {}).snapshot
    expect(strayless.map((entry) => entry.key)).toEqual([GIT_KEY, FOLDER_KEY])
  })

  it('publishes a workspace when a write changes it by value, and its removal', async () => {
    const { stream, write } = setup()
    const events: WorkspaceLayoutEvent[] = []
    stream.subscribe((event) => events.push(event))
    const session = localDesktopSession()
    write(LOCAL_EXECUTION_HOST_ID, session)
    await flush()
    expect(events).toEqual([])

    session.tabGroups![GIT_KEY]![0]!.tabOrder.reverse()
    write(LOCAL_EXECUTION_HOST_ID, session)
    // A burst of writes in one task is one projection.
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
    expect(events.at(-1)).toEqual({ type: 'removed', key: FOLDER_KEY })
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
    const events: WorkspaceLayoutEvent[] = []
    stream.subscribe(() => {
      throw new Error('listener failed')
    })
    stream.subscribe((event) => events.push(event))
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
    // Rows a headless host saved with no tab bar or pane layout: their groups and panes are invented.
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
      homeHostId: () => LOCAL_EXECUTION_HOST_ID
    })
    const events: WorkspaceLayoutEvent[] = []
    const before = new Map(
      stream
        .subscribe((event) => events.push(event))
        .snapshot.map((entry) => [entry.key, JSON.stringify(entry.layout)])
    )
    fake.write(LOCAL_EXECUTION_HOST_ID, rowsOnly(keys.slice(1), ['t1', 't2']))
    await flush()
    expect(events).toEqual([{ type: 'removed', key: 'repo-1::/a' }])

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
})
