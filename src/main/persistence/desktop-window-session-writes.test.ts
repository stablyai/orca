import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  let serial = 0
  class Contents extends EventEmitter {
    id = ++serial
    isDestroyed = (): boolean => false
    getType = (): string => 'window'
  }
  return {
    BrowserWindow: class {
      webContents = new Contents()
    }
  }
})

import { BrowserWindow } from 'electron'
import { getDefaultUIState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  addWorkspace,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import {
  listDesktopRenderers,
  registerDesktopRenderer,
  unregisterDesktopRenderer
} from '../window/desktop-renderer-registry'
import {
  prepareDesktopWindowSessionWrite,
  readDesktopWindowSession
} from './desktop-window-session-writes'
import { collectTabGroupLayoutGroupIds } from '../../shared/workspace-layout/tab-group-moves'

afterEach(() => {
  for (const renderer of listDesktopRenderers()) {
    unregisterDesktopRenderer(renderer)
  }
})

function withTabs(session: WorkspaceSessionState, ids: number[]): WorkspaceSessionState {
  return addWorkspace(structuredClone(session), GIT_KEY, [
    {
      id: 'group',
      tabs: ids.map((id) => ({ id: `tab-${id}`, leaves: [[leaf(id), `pty-${id}`]] }))
    }
  ])
}

function fixture() {
  let session = withTabs(getDefaultWorkspaceSession(), [1])
  const first = new BrowserWindow({ show: false }).webContents
  const second = new BrowserWindow({ show: false }).webContents
  registerDesktopRenderer(first, 'first')
  registerDesktopRenderer(second, 'second')
  const store = { getUI: getDefaultUIState, getWorkspaceSession: () => session }
  return {
    first,
    second,
    store,
    storeSession: (next: WorkspaceSessionState) => {
      session = next
    }
  }
}

describe('concurrent desktop session saves', () => {
  it('preserves independent tab additions from two windows that read the same starting session', () => {
    const { first, second, store, storeSession } = fixture()
    const a = readDesktopWindowSession(store, first)
    const b = readDesktopWindowSession(store, second)
    const firstWrite = prepareDesktopWindowSessionWrite(store, first, {
      kind: 'set',
      session: withTabs(a, [1, 2])
    })
    expect(firstWrite).not.toBeNull()
    if (!firstWrite) {
      return
    }
    storeSession(firstWrite.shared)
    firstWrite.commit()
    const secondWrite = prepareDesktopWindowSessionWrite(store, second, {
      kind: 'patch',
      patch: withTabs(b, [1, 3])
    })
    expect(secondWrite?.shared.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id).sort()).toEqual([
      'tab-1',
      'tab-2',
      'tab-3'
    ])
    expect(Object.keys(secondWrite?.shared.terminalLayoutsByTabId ?? {}).sort()).toEqual([
      'tab-1',
      'tab-2',
      'tab-3'
    ])
    expect(secondWrite?.shared.tabGroups?.[GIT_KEY]?.[0]?.tabOrder.toSorted()).toEqual([
      'tab-1',
      'tab-2',
      'tab-3'
    ])
  })

  it('applies a close from one window without dropping the other window new tab', () => {
    const { first, second, store, storeSession } = fixture()
    const a = readDesktopWindowSession(store, first)
    const b = readDesktopWindowSession(store, second)
    const add = prepareDesktopWindowSessionWrite(store, first, {
      kind: 'set',
      session: withTabs(a, [1, 2])
    })
    if (!add) {
      throw new Error('Missing native window write')
    }
    storeSession(add.shared)
    add.commit()
    const close = prepareDesktopWindowSessionWrite(store, second, {
      kind: 'set',
      session: withTabs(b, [])
    })
    expect(close?.shared.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id)).toEqual(['tab-2'])
    expect(close?.shared.terminalLayoutsByTabId['tab-2']?.ptyIdsByLeafId).toEqual({
      [leaf(2)]: 'pty-2'
    })
    expect(close?.shared.tabGroups?.[GIT_KEY]?.[0]?.tabOrder).toEqual(['tab-2'])
  })

  it('keeps a failed save retry based on the last committed view', () => {
    const { first, store, storeSession } = fixture()
    const original = readDesktopWindowSession(store, first)
    prepareDesktopWindowSessionWrite(store, first, {
      kind: 'set',
      session: withTabs(original, [1, 2])
    })
    storeSession(withTabs(original, [1, 3]))
    const retry = prepareDesktopWindowSessionWrite(store, first, {
      kind: 'set',
      session: withTabs(original, [1, 2])
    })
    expect(retry?.shared.tabsByWorktree[GIT_KEY]?.map((tab) => tab.id).sort()).toEqual([
      'tab-1',
      'tab-2',
      'tab-3'
    ])
  })

  it('keeps both concurrently created groups reachable from the stored group tree', () => {
    const { first, second, store, storeSession } = fixture()
    const a = readDesktopWindowSession(store, first)
    const b = readDesktopWindowSession(store, second)
    const split = (base: WorkspaceSessionState, id: number) =>
      addWorkspace(structuredClone(base), GIT_KEY, [
        { id: 'group', tabs: [{ id: 'tab-1', leaves: [[leaf(1), 'pty-1']] }] },
        { id: `group-${id}`, tabs: [{ id: `tab-${id}`, leaves: [[leaf(id), `pty-${id}`]] }] }
      ])
    const firstWrite = prepareDesktopWindowSessionWrite(store, first, {
      kind: 'set',
      session: split(a, 2)
    })
    if (!firstWrite) {
      throw new Error('Missing native window write')
    }
    storeSession(firstWrite.shared)
    firstWrite.commit()
    const secondWrite = prepareDesktopWindowSessionWrite(store, second, {
      kind: 'set',
      session: split(b, 3)
    })
    if (!secondWrite) {
      throw new Error('Missing native window write')
    }
    expect(
      [...collectTabGroupLayoutGroupIds(secondWrite.shared.tabGroupLayouts?.[GIT_KEY])].sort()
    ).toEqual(['group', 'group-2', 'group-3'])
  })
})
