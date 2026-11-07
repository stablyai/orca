import { expect, it } from 'vitest'
import { registerLivePty } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'

it('names the PTY a desktop window pane handle shows', () => {
  const tabId = 'tab-run'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const runtime = new OrcaRuntimeService(store)
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId, worktreeId: TEST_WORKTREE_ID, title: 'run', activeLeafId: leafId, layout: null }
    ],
    leaves: [
      {
        tabId,
        worktreeId: TEST_WORKTREE_ID,
        leafId,
        paneRuntimeId: 1,
        ptyId: 'pty-run',
        paneTitle: null
      }
    ]
  })
  registerLivePty(runtime, 'pty-run', TEST_WORKTREE_ID, null, { tabId, leafId })

  const handle = runtime.getTerminalHandleForPaneKey(makePaneKey(tabId, leafId))

  expect(handle && runtime.getTerminalPtyIdForHandle(handle)).toBe('pty-run')
})
