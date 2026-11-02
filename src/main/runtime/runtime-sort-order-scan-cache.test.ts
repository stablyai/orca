import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import './orca-runtime-test-lifecycle.spec'
import { OrcaRuntimeService, listWorktrees } from './orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from './orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  makeWorktreeInfo,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'
import { registerRuntimeWindowLifecycle } from '../window/runtime-window-lifecycle'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))

const firstPath = join(TEST_REPO_PATH, 'first')
const secondPath = join(TEST_REPO_PATH, 'second')
const firstId = `${TEST_REPO_ID}::${firstPath}`
const secondId = `${TEST_REPO_ID}::${secondPath}`

async function createScannedRuntime(): Promise<InstanceType<typeof OrcaRuntimeService>> {
  const metaById: Record<string, WorktreeMeta> = {
    [firstId]: makeWorktreeMeta({ sortOrder: 200 }),
    [secondId]: makeWorktreeMeta({ sortOrder: 100 })
  }
  const runtime = new OrcaRuntimeService({
    ...store,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...metaById[id], ...meta }
      return metaById[id]
    }
  })
  vi.mocked(listWorktrees).mockClear()
  vi.mocked(listWorktrees).mockResolvedValue([
    makeWorktreeInfo(firstPath),
    makeWorktreeInfo(secondPath)
  ])
  await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
  return runtime
}

async function expectOrderSaveSkipsGitScan(
  runtime: InstanceType<typeof OrcaRuntimeService>
): Promise<void> {
  const events: RuntimeClientEvent[] = []
  const unsubscribe = runtime.onClientEvent((event) => events.push(event))

  expect(runtime.persistManagedWorktreeSortOrder([secondId, firstId])).toEqual({ updated: 2 })
  unsubscribe()
  const listed = await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)

  expect(listWorktrees).toHaveBeenCalledTimes(1)
  const sortOrderOf = (id: string) =>
    listed.worktrees.find((worktree) => worktree.id === id)?.sortOrder ?? Number.NaN
  expect(sortOrderOf(secondId)).toBeGreaterThan(sortOrderOf(firstId))
  // The event carries the saved values so a client can patch rows without refetching them.
  expect(events).toEqual([
    {
      type: 'worktreesChanged',
      repoId: TEST_REPO_ID,
      sortOrderOnly: true,
      sortOrders: [
        { worktreeId: secondId, sortOrder: sortOrderOf(secondId) },
        { worktreeId: firstId, sortOrder: sortOrderOf(firstId) }
      ]
    }
  ])

  runtime.publishWorktreeRemovalChange(TEST_REPO_ID)
  await runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)
  expect(listWorktrees).toHaveBeenCalledTimes(2)
}

describe('runtime sort-order saves', () => {
  it('publishes the changed order without rescanning Git on a headless host', async () => {
    await expectOrderSaveSkipsGitScan(await createScannedRuntime())
  })

  it('publishes the changed order without rescanning Git through the desktop window notifier', async () => {
    const runtime = await createScannedRuntime()
    const send = vi.fn()
    const mainWindow = {
      id: 1,
      isDestroyed: () => false,
      on: vi.fn(),
      webContents: { isDestroyed: () => false, send, on: vi.fn() }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only reads id, isDestroyed, on and webContents.
    registerRuntimeWindowLifecycle(mainWindow as unknown as BrowserWindow, runtime)

    await expectOrderSaveSkipsGitScan(runtime)
    expect(send).toHaveBeenCalledWith('worktrees:changed', { repoId: TEST_REPO_ID })
  })
})
