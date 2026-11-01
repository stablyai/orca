import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../persistence/persistence-test-harness'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn().mockReturnValue({}) }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

import { registerSessionHandlers } from './session'

const OTHER_KEY = 'repo-1::/Users/dev/other'

/** Main's partition: one workspace with two terminal tabs, the first split in two panes. */
function mainSession(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: [
        {
          id: 'tab-a',
          leaves: [
            [leaf(1), 'pty-1'],
            [leaf(2), 'pty-2']
          ]
        },
        { id: 'tab-b', leaves: [[leaf(3), 'pty-3']] }
      ]
    }
  ])
}

/** What a window that lags main saves: tab-b closed, a tab main never got, one pane, new titles. */
function laggingWindowSave(): WorkspaceSessionState {
  const save = addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'group-1',
      tabs: [
        { id: 'tab-a', title: 'vim', leaves: [[leaf(1), 'pty-1']] },
        { id: 'tab-new', leaves: [[leaf(5), 'pty-5']] }
      ]
    }
  ])
  return {
    ...save,
    activeWorktreeId: GIT_KEY,
    lastVisitedAtByWorktreeId: { [GIT_KEY]: 5, [OTHER_KEY]: 6 }
  }
}

function terminalTabs(session: WorkspaceSessionState, key = GIT_KEY): string[] {
  return (session.tabsByWorktree[key] ?? []).map((row) => row.id)
}

async function call(channel: string, ...args: unknown[]): Promise<void> {
  await handlers.get(channel)!({}, ...args)
}

describe('a window save in a layout-owner build', () => {
  let store: ReturnType<typeof createStore>
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    store = createStore()
    // Reconnect facts are covered separately in window-save-reconnect-facts.test.ts.
    const runtime = {
      shutdownReconnectFactsFor: (session: WorkspaceSessionState) => ({
        activeWorktreeIdsOnShutdown: session.activeWorktreeIdsOnShutdown,
        remoteSessionIdsByTabId: session.remoteSessionIdsByTabId,
        activeConnectionIdsAtShutdown: session.activeConnectionIdsAtShutdown
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the save handlers reach only this runtime method.
    registerSessionHandlers(store, runtime as never)
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps main’s tabs and panes, and takes the window’s view and titles', async () => {
    store.setWorkspaceSession(mainSession(), 'local')

    await call('session:set', laggingWindowSave(), 'local')

    const saved = store.getWorkspaceSession('local')
    expect(terminalTabs(saved)).toEqual(['tab-a', 'tab-b'])
    expect(saved.unifiedTabs?.[GIT_KEY]?.map((entry) => entry.id)).toEqual(['tab-a', 'tab-b'])
    expect(saved.terminalLayoutsByTabId['tab-a']?.root).toEqual(
      mainSession().terminalLayoutsByTabId['tab-a']!.root
    )
    expect(saved.terminalLayoutsByTabId['tab-new']).toBeUndefined()
    expect(saved.tabsByWorktree[GIT_KEY]?.[0]?.title).toBe('vim')
    expect(saved.activeWorktreeId).toBe(GIT_KEY)
  })

  it('takes a scrollback patch into main’s panes and leaves main’s tree', async () => {
    store.setWorkspaceSession(mainSession(), 'local')
    const windowLayout = laggingWindowSave().terminalLayoutsByTabId['tab-a']!

    await call(
      'session:patch',
      {
        terminalLayoutsByTabId: {
          'tab-a': { ...windowLayout, buffersByLeafId: { [leaf(1)]: 'scrollback' } }
        }
      },
      'local'
    )

    const layout = store.getWorkspaceSession('local').terminalLayoutsByTabId['tab-a']
    expect(layout?.root).toEqual(mainSession().terminalLayoutsByTabId['tab-a']!.root)
    expect(Object.keys(layout?.scrollbackRefsByLeafId ?? {})).toEqual([leaf(1)])
    expect(terminalTabs(store.getWorkspaceSession('local'))).toEqual(['tab-a', 'tab-b'])
  })

  it('gives a visited workspace main holds its terminal row, and one main lacks none', async () => {
    store.setWorkspaceSession(
      addWorkspace(emptySession(), GIT_KEY, [
        { id: 'group-1', tabs: [{ id: 'editor-1', kind: 'editor' }] }
      ]),
      'local'
    )
    const save = {
      ...addWorkspace(emptySession(), GIT_KEY, [
        { id: 'group-1', tabs: [{ id: 'editor-1', kind: 'editor' }] }
      ]),
      tabsByWorktree: { [GIT_KEY]: [], [OTHER_KEY]: [] },
      lastVisitedAtByWorktreeId: { [GIT_KEY]: 5, [OTHER_KEY]: 6 }
    }

    await call('session:set', save, 'local')

    const saved = store.getWorkspaceSession('local')
    expect(Object.hasOwn(saved.tabsByWorktree, GIT_KEY)).toBe(true)
    expect(Object.hasOwn(saved.tabsByWorktree, OTHER_KEY)).toBe(false)
  })

  it('writes a paired server’s partition as the window sent it', async () => {
    store.setWorkspaceSession(mainSession(), 'runtime:env-1')

    await call('session:set', laggingWindowSave(), 'runtime:env-1')

    expect(terminalTabs(store.getWorkspaceSession('runtime:env-1'))).toEqual(['tab-a', 'tab-new'])
  })
})
