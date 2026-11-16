import './runtime-orchestration-db.test-fixture'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { describe, expect, it, vi } from 'vitest'
import '../../../shared/workspace-layout/layout-owner-switch'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../shared/orca-profiles/constants'
import '../../../shared/workspace-layout/stable-pane-id'

import {
  HEADLESS_LEAF_ID,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  deferred,
  makeRuntimeStoreWithWorkspaceSession
} from './orca-runtime-test-fixtures.spec'
import './orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('preserves concurrent workspace-session changes when async orphan persistence fails', async () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: TEST_REPO_ID,
      activeWorktreeId: TEST_WORKTREE_ID,
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    }
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const durableWrite = deferred<void>()
    const durableWriteStarted = deferred<void>()
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({
        ...runtimeStore,
        flushPendingOrThrowAsync: vi.fn(() => {
          durableWriteStarted.resolve()
          return durableWrite.promise
        })
      })
    )
    runtime.setPtyController({
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          terminalHandle: 'term_async_rollback',
          title: 'Async rollback',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    const adoption = runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_async_rollback',
          ptyId: 'pty-async-rollback',
          incarnationId: 'inc-async-rollback',
          tabId: 'tab-async-rollback',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })
    await durableWriteStarted.promise
    setSession({
      ...getSession(),
      activeTabIdByWorktree: {
        ...getSession().activeTabIdByWorktree,
        'concurrent-worktree': 'concurrent-tab'
      }
    })
    durableWrite.reject(new Error('disk unavailable'))

    await expect(adoption).rejects.toThrow('disk unavailable')
    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(getSession().terminalLayoutsByTabId['tab-async-rollback']).toBeUndefined()
    expect(getSession().activeTabIdByWorktree?.['concurrent-worktree']).toBe('concurrent-tab')
    expect(getSession().terminalTopologyRevisionByRepoId?.[TEST_REPO_ID] ?? 0).toBe(0)
  })
})
