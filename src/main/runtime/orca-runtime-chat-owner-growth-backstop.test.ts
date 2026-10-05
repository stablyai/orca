import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import type { Tab } from '../../shared/tab-types'

const A = HEADLESS_LEAF_ID
const B = HEADLESS_SECOND_LEAF_ID

const CHAT_TAB: Tab = {
  id: 'host-tab',
  entityId: 'host-tab',
  groupId: 'group-1',
  worktreeId: TEST_WORKTREE_ID,
  contentType: 'terminal',
  label: 'Persisted Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1,
  viewMode: 'chat'
}

describe('F1: every runtime session write pins an ownerless chat whose tree grows (R1X-1)', () => {
  it('orphan adoption into a single-pane chat keeps chat on the pane it had', async () => {
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal({
        unifiedTabs: { [TEST_WORKTREE_ID]: [CHAT_TAB] }
      })
    )
    const runtime = new OrcaRuntimeService(
      withDurableRuntimeStore({ ...runtimeStore, flushOrThrow: vi.fn() })
    )
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-orphan',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'shell',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: 0,
      claims: [
        {
          terminal: 'term_orphan',
          ptyId: 'pty-orphan',
          incarnationId: 'inc-orphan',
          tabId: 'host-tab',
          leafId: B
        }
      ]
    })

    const layout = getSession().terminalLayoutsByTabId['host-tab']
    expect(layout?.root).toMatchObject({
      type: 'split',
      first: { type: 'leaf', leafId: A },
      second: { type: 'leaf', leafId: B }
    })
    expect(layout?.chatLeafId).toBe(A)
  })
})
