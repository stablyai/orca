import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import { MOCK_GIT_WORKTREES } from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import {
  TEST_FOLDER_WORKSPACE_PATH,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('keeps targeted terminal lists from adopting controller PTYs for other worktrees', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      ...MOCK_GIT_WORKTREES,
      {
        path: '/tmp/worktree-b',
        head: 'def',
        branch: 'feature/bar',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/tmp/worktree-a/nested',
        head: 'ghi',
        branch: 'feature/nested',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'target-controller-pty', cwd: '/tmp/worktree-a/src', title: 'target' },
        { id: 'other-controller-pty', cwd: '/tmp/worktree-b/src', title: 'other' },
        {
          id: 'repo-1::/tmp/worktree-b@@other-controller-pty',
          cwd: '/tmp/worktree-a/src',
          title: 'prefixed other'
        },
        { id: 'nested-controller-pty', cwd: '/tmp/worktree-a/nested/src', title: 'nested' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals(`path:${TEST_WORKTREE_PATH}`)

    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      worktreePath: TEST_WORKTREE_PATH
    })
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('target-controller-pty')).toBe(true)
    expect(internals.ptysById.has('other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('repo-1::/tmp/worktree-b@@other-controller-pty')).toBe(false)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps explicit-id cold-cache terminal lists from adopting nested worktree PTYs', async () => {
    const nestedWorktreeId = `${TEST_REPO_ID}::${TEST_WORKTREE_PATH}/nested`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('explicit-id fallback should not rescan worktrees')
    )
    const runtime = new OrcaRuntimeService({
      ...store,
      getAllWorktreeMeta: () => ({
        [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
        [nestedWorktreeId]: makeWorktreeMeta()
      }),
      getWorktreeMeta: (worktreeId: string) =>
        ({
          [TEST_WORKTREE_ID]: store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
          [nestedWorktreeId]: makeWorktreeMeta()
        })[worktreeId]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'cwd-only-pty', cwd: `${TEST_WORKTREE_PATH}/src`, title: 'cwd shell' },
        { id: 'nested-controller-pty', cwd: `${TEST_WORKTREE_PATH}/nested/src`, title: 'nested' }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals.map((terminal) => terminal.worktreeId)).toEqual([TEST_WORKTREE_ID])
    const internals = runtime as unknown as { ptysById: Map<string, unknown> }
    expect(internals.ptysById.has('cwd-only-pty')).toBe(true)
    expect(internals.ptysById.has('nested-controller-pty')).toBe(false)
  })

  it('keeps same-path folder workspace instance PTYs scoped to their exact ids', async () => {
    const firstWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}11111111-1111-4111-8111-111111111111`
    const secondWorktreeId = `${TEST_REPO_ID}::${TEST_FOLDER_WORKSPACE_PATH}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}22222222-2222-4222-8222-222222222222`
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(listWorktrees).mockRejectedValue(
      new Error('folder explicit-id fallback should not rescan worktrees')
    )
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'first-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'first',
          worktreeId: firstWorktreeId
        },
        {
          id: 'second-folder-pty',
          cwd: TEST_FOLDER_WORKSPACE_PATH,
          title: 'second',
          worktreeId: secondWorktreeId
        }
      ]
    })

    const terminals = await runtime.listTerminals(`id:${secondWorktreeId}`)

    expect(listWorktrees).not.toHaveBeenCalled()
    expect(terminals.terminals).toHaveLength(1)
    expect(terminals.terminals[0]).toMatchObject({
      ptyId: 'second-folder-pty',
      worktreeId: secondWorktreeId,
      worktreePath: TEST_FOLDER_WORKSPACE_PATH
    })
    const internals = runtime as unknown as {
      ptysById: Map<string, { worktreeId: string }>
    }
    expect(internals.ptysById.get('first-folder-pty')).toBeUndefined()
    expect(internals.ptysById.get('second-folder-pty')?.worktreeId).toBe(secondWorktreeId)
  })
})
