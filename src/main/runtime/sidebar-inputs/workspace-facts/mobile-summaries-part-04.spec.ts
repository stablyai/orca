import { describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../orca-runtime-test-mocks/setup.spec'
import '../../../workspaces/catalog/worktree-path-comparison-key'

import {
  store,
  syncSinglePty
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('clears stale working status after the agent exits and the shell takes over the title', async () => {
    // Recompute from the live title so retained agent status cannot strand a working spinner (#1437).
    const runtime = new OrcaRuntimeService(store)

    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Codex working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const working = await runtime.getWorktreePs()
    expect(working.worktrees[0].status).toBe('working')

    runtime.onPtyData('pty-1', '\x1b]0;bash\x07', 200)
    const afterExit = await runtime.getWorktreePs()
    expect(afterExit.worktrees[0].status).toBe('active')
  })

  it('shows worktree.ps active when the current pane is the Claude agents screen', async () => {
    const runtime = new OrcaRuntimeService(store)

    await syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    await syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })

    const summary = await runtime.getWorktreePs()

    expect(summary.worktrees[0].status).toBe('active')
  })
})
