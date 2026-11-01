import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RemoteLayoutSnapshot } from '../../shared/remote-layout-snapshot'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { scanSourceTree, stripComments } from '../../shared/source-scan/source-tree-scan'
import {
  forgetRemoteLayoutSnapshot,
  recordRemoteLayoutFrame,
  type RemoteLayoutSnapshotStore
} from './remote-layout-snapshot-recorder'

const METHOD = 'session.tabs.subscribeAll'

function memoryStore() {
  const snapshots = new Map<string, RemoteLayoutSnapshot>()
  const saves: ('now' | 'later')[] = []
  const store: RemoteLayoutSnapshotStore = {
    getRemoteLayoutSnapshot: (environmentId) => snapshots.get(environmentId),
    setRemoteLayoutSnapshot: (environmentId, snapshot, save) => {
      saves.push(save)
      if (snapshot) {
        snapshots.set(environmentId, snapshot)
      } else {
        snapshots.delete(environmentId)
      }
    }
  }
  return { store, snapshots, saves }
}

function tabs(worktree: string, title = 'shell') {
  return {
    worktree,
    publicationEpoch: 'epoch',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [{ type: 'terminal', id: `${worktree}-tab`, title }]
  }
}

function frame(result: unknown, runtimeId = 'server-1'): RuntimeRpcResponse<unknown> {
  return { id: 'stream', ok: true, result, _meta: { runtimeId } }
}

function workspacesOf(snapshots: Map<string, RemoteLayoutSnapshot>, environmentId = 'env') {
  return snapshots.get(environmentId)?.workspaces
}

describe('remote layout snapshot recorder', () => {
  it('replaces the whole entry on each census, dropping worktrees it no longer lists', () => {
    const { store, snapshots } = memoryStore()
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({ type: 'snapshots', snapshots: [tabs('a'), tabs('b')] })
    )
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({ type: 'snapshots', snapshots: [tabs('b', 'renamed')] }, 'server-2')
    )

    expect(snapshots.get('env')).toEqual({ workspaces: { b: tabs('b', 'renamed') } })
  })

  it('replaces one worktree on an update and drops it on a removal', () => {
    const { store, snapshots } = memoryStore()
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({ type: 'snapshots', snapshots: [tabs('a'), tabs('b')] })
    )
    recordRemoteLayoutFrame(store, 'env', METHOD, frame({ type: 'updated', ...tabs('a', 'vim') }))
    expect(workspacesOf(snapshots)).toEqual({ a: tabs('a', 'vim'), b: tabs('b') })

    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({ type: 'updated', ...tabs('b'), tabs: [], removed: true })
    )
    expect(workspacesOf(snapshots)).toEqual({ a: tabs('a', 'vim') })
  })

  it('keeps neither retirement proofs nor one-shot navigation', () => {
    const { store, snapshots } = memoryStore()
    const proof = { parentTabId: 'a-tab', leafId: 'leaf', ptyId: 'pty', terminal: 'term' }
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({ type: 'snapshots', snapshots: [{ ...tabs('a'), retiredTerminalSurfaces: [proof] }] })
    )
    expect(workspacesOf(snapshots)).toEqual({ a: tabs('a') })

    // A capable client is sent only new proofs, so an update's list is a delta, here empty.
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      frame({
        type: 'updated',
        ...tabs('a', 'vim'),
        retiredTerminalSurfaces: [],
        navigationIntent: 'follow'
      })
    )
    expect(workspacesOf(snapshots)).toEqual({ a: tabs('a', 'vim') })
  })

  it('saves at once only when tabs or groups change; title ticks ride the next save', () => {
    const { store, saves } = memoryStore()
    const census = (snapshots: unknown[]) => frame({ type: 'snapshots', snapshots })
    const update = (result: Record<string, unknown>) => frame({ type: 'updated', ...result })
    recordRemoteLayoutFrame(store, 'env', METHOD, census([tabs('a')]))
    recordRemoteLayoutFrame(store, 'env', METHOD, update(tabs('a', 'thinking.')))
    recordRemoteLayoutFrame(store, 'env', METHOD, update(tabs('a', 'thinking..')))
    const twoTabs = {
      ...tabs('a'),
      tabs: [...tabs('a').tabs, { type: 'terminal', id: 'second', title: 'shell' }]
    }
    recordRemoteLayoutFrame(store, 'env', METHOD, update(twoTabs))
    const grouped = {
      ...twoTabs,
      tabGroups: [{ id: 'g', activeTabId: null, tabOrder: ['second'] }]
    }
    recordRemoteLayoutFrame(store, 'env', METHOD, update(grouped))
    recordRemoteLayoutFrame(
      store,
      'env',
      METHOD,
      update({ ...grouped, tabGroups: [{ id: 'g', activeTabId: 'second', tabOrder: ['second'] }] })
    )
    recordRemoteLayoutFrame(store, 'env', METHOD, update({ ...tabs('a'), tabs: [], removed: true }))
    expect(saves).toEqual(['now', 'later', 'later', 'now', 'now', 'later', 'now'])
  })

  it('keeps each server in its own entry', () => {
    const { store, snapshots } = memoryStore()
    recordRemoteLayoutFrame(
      store,
      'one',
      METHOD,
      frame({ type: 'snapshots', snapshots: [tabs('a')] })
    )
    recordRemoteLayoutFrame(store, 'two', METHOD, frame({ type: 'snapshots', snapshots: [] }))
    expect(workspacesOf(snapshots, 'one')).toEqual({ a: tabs('a') })
    expect(workspacesOf(snapshots, 'two')).toEqual({})
  })

  it('records nothing from other streams, failures, ends or unreadable frames', () => {
    const { store, saves } = memoryStore()
    const census = { type: 'snapshots', snapshots: [tabs('a')] }
    recordRemoteLayoutFrame(store, 'env', 'session.tabs.subscribe', frame(census))
    recordRemoteLayoutFrame(store, 'env', 'terminal.multiplex', frame(census))
    recordRemoteLayoutFrame(store, 'env', METHOD, {
      id: 'stream',
      ok: false,
      error: { code: 'method_not_found', message: 'nope' },
      _meta: { runtimeId: 'server-1' }
    })
    recordRemoteLayoutFrame(store, 'env', METHOD, frame({ type: 'end' }))
    recordRemoteLayoutFrame(store, 'env', METHOD, frame({ type: 'snapshots', snapshots: [{}] }))
    recordRemoteLayoutFrame(store, 'env', METHOD, frame({ type: 'updated', worktree: 'a' }))
    expect(saves).toEqual([])
  })

  it('forgets a removed server', () => {
    const { store, snapshots } = memoryStore()
    recordRemoteLayoutFrame(store, 'env', METHOD, frame({ type: 'snapshots', snapshots: [] }))
    forgetRemoteLayoutSnapshot(store, 'env')
    expect(snapshots.has('env')).toBe(false)
  })

  it('is the only code that writes the snapshot', () => {
    const src = join(__dirname, '../..')
    const writers = scanSourceTree(src)
      .filter(({ source }) => stripComments(source).includes('setRemoteLayoutSnapshot('))
      .map(({ relativePath }) => relativePath)
    expect(writers.sort()).toEqual([
      'main/remote-layout-snapshot/remote-layout-snapshot-persistence.ts',
      'main/remote-layout-snapshot/remote-layout-snapshot-recorder.ts'
    ])
  })
})
