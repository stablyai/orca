import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS,
  hasClosedTerminalTabRecord
} from '../../shared/closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../../shared/execution-host'
import { Store } from '../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { TERMINAL_LIFECYCLE_METHODS } from './rpc/methods/terminal/terminal-lifecycle-methods'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const createMethod = TERMINAL_LIFECYCLE_METHODS.find((method) => method.name === 'terminal.create')

async function persistedTab(hostId: ExecutionHostId, close = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-closed-create-'))
  directories.push(directory)
  const dataFile = join(directory, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  const repo = {
    id: 'repo-1',
    path: directory,
    displayName: 'Fixture',
    badgeColor: 'gray',
    addedAt: 1
  }
  store.addRepo(repo)
  const worktreeId = `${repo.id}::${repo.path}`
  const pane = { tabId: randomUUID(), leafId: randomUUID() }
  store.setWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: pane.tabId,
            ptyId: 'old-pty',
            worktreeId,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [pane.tabId]: {
          root: { type: 'leaf', leafId: pane.leafId },
          activeLeafId: pane.leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [pane.leafId]: 'old-pty' }
        }
      }
    },
    hostId
  )
  const runtime = new OrcaRuntimeService(store)
  if (close) {
    await runtime.closeTerminalSurfaceFromRenderer({
      worktreeId,
      target: { kind: 'tab', tabId: pane.tabId },
      reason: 'user'
    })
  }
  expect(
    hasClosedTerminalTabRecord(
      store.getWorkspaceSession(hostId).closedTerminalTabTombstonesByTabId,
      pane.tabId,
      worktreeId
    )
  ).toBe(close)
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  const reloaded = createSqliteTestStore(Store, { dataFile })
  expect(
    hasClosedTerminalTabRecord(
      reloaded.getWorkspaceSession(hostId).closedTerminalTabTombstonesByTabId,
      pane.tabId,
      worktreeId
    )
  ).toBe(close)
  const restarted = new OrcaRuntimeService(reloaded)
  Object.assign(restarted, {
    resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
      id: worktreeId,
      path: directory,
      connectionId: null,
      repo,
      folderWorkspace: null
    }))
  })
  const spawn = vi.fn(async () => ({ id: 'replacement-pty' }))
  const listProcesses = vi.fn(async () => [])
  restarted.setPtyController({
    spawn,
    listProcesses,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const create = (identity = pane) => {
    if (!createMethod) {
      throw new Error('terminal.create method missing')
    }
    return createMethod.handler(
      { worktree: `id:${worktreeId}`, ...identity },
      { runtime: restarted, pairedDeviceId: 'old-desktop', clientKind: 'runtime' }
    )
  }
  return { reloaded, worktreeId, pane, spawn, listProcesses, create }
}

describe('shipped terminal.create after a durable host close', () => {
  it.each(['local', 'runtime:legacy-host'] as const)(
    'refuses a stale id closed in %s before spawning, including after restart',
    async (hostId) => {
      const { reloaded, worktreeId, pane, spawn, listProcesses, create } =
        await persistedTab(hostId)
      await expect(create()).rejects.toThrow('tab_not_found')
      expect(spawn).not.toHaveBeenCalled()
      expect(listProcesses).not.toHaveBeenCalled()
      expect(reloaded.getWorkspaceSession().tabsByWorktree[worktreeId] ?? []).toEqual([])
      expect(
        reloaded.getWorkspaceSession(hostId).terminalLayoutsByTabId[pane.tabId]
      ).toBeUndefined()
    }
  )

  it('still accepts a valid unseen identity', async () => {
    const { spawn, create } = await persistedTab('local')
    await expect(create({ tabId: randomUUID(), leafId: randomUUID() })).resolves.toHaveProperty(
      'terminal.ptyId',
      'replacement-pty'
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps recovery of a persisted pane without an explicit tab close', async () => {
    const { spawn, create } = await persistedTab('local', false)
    await expect(create()).resolves.toHaveProperty('terminal.ptyId', 'replacement-pty')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('preserves the existing close-record expiry policy', async () => {
    const { reloaded, worktreeId, pane, spawn, create } = await persistedTab('local')
    reloaded.setWorkspaceSession({
      ...reloaded.getWorkspaceSession(),
      closedTerminalTabTombstonesByTabId: {
        [pane.tabId]: {
          worktreeId,
          closedAt: Date.now() - CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS - 60_000,
          reason: 'user'
        }
      }
    })
    await expect(create()).resolves.toHaveProperty('terminal.ptyId', 'replacement-pty')
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
