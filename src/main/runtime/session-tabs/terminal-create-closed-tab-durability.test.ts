import type { PtyProcessInfo } from '../../providers/pty/process-info'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { hasClosedTerminalTabRecord } from '../../../shared/workspace-layout/terminal-surfaces/closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { Store } from '../../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_LIFECYCLE_METHODS } from '../rpc/methods/terminal/terminal-lifecycle-methods'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

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
  const listProcesses = vi.fn<() => Promise<PtyProcessInfo[]>>(async () => [])
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
  return { reloaded, runtime: restarted, worktreeId, pane, spawn, listProcesses, create }
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
  it('isolates an account restart from an earlier mutation and rejoins only the same restart attempt', async () => {
    const { runtime, worktreeId, pane, listProcesses } = await persistedTab('local', false)
    const live: PtyProcessInfo[] = []
    listProcesses.mockImplementation(async () => live)
    const createTerminal = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_selector, options = {}) => {
        if (!options.preAllocatedHandle) {
          throw new Error('missing replay handle')
        }
        const ptyId = options.accountRestart ? 'restart-pty' : 'previous-pty'
        live.push({
          id: ptyId,
          cwd: '/tmp',
          title: 'Codex',
          terminalHandle: options.preAllocatedHandle,
          worktreeId
        })
        return { handle: options.preAllocatedHandle, ptyId, worktreeId, title: null }
      })
    if (!createMethod) {
      throw new Error('terminal.create method missing')
    }
    const context = { runtime, pairedDeviceId: 'old-desktop', clientKind: 'runtime' as const }
    const params = { worktree: `id:${worktreeId}`, ...pane, clientMutationId: 'earlier-create' }
    await createMethod.handler(params, context)
    const restart = {
      ...params,
      reconcileExisting: true,
      accountRestart: {
        requestId: 'account-request',
        attemptId: 'account-attempt',
        hostEpoch: 'host',
        pane: { worktreeId, ...pane, tabCreatedAt: 1 },
        expected: { kind: 'empty' as const, bindingGeneration: 1 }
      }
    }
    await expect(createMethod.handler(restart, context)).resolves.toMatchObject({
      terminal: { ptyId: 'restart-pty' }
    })
    await expect(createMethod.handler(restart, context)).resolves.toMatchObject({
      terminal: { ptyId: 'restart-pty' }
    })
    expect(createTerminal).toHaveBeenCalledTimes(2)
  })
})
