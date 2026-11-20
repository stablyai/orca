import '../../construction/test-context/orca-runtime-test-lifecycle.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { describe, expect, it, vi } from 'vitest'

import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { committingSpawn } from '../layout/bind-first-pane.test-fixture'
import '../../session-lifecycle/projection/runtime-mobile-agent-status-builder'

describe('terminal rename before renderer graph hydration', () => {
  it('persists, forwards, and clears a title across consecutive PTY replacements', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const renameTerminal = vi.fn()
    const open = async (ptyId: string) => {
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.setPtyController({
        spawn: vi.fn(committingSpawn(runtime, async () => ({ id: ptyId }))),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal,
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      return { runtime, handle: terminal.handle }
    }
    const customTitle = () => getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle

    const initial = await open('omp-initial-pty')
    await initial.runtime.renameTerminal(initial.handle, 'Media Engine Orch')
    expect(customTitle()).toBe('Media Engine Orch')
    expect(renameTerminal).toHaveBeenLastCalledWith('host-tab', 'Media Engine Orch')
    // Main-owned last-pane exit closes the tab; restart from the saved session in that mode.
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      initial.runtime.onPtyExit('omp-initial-pty', 0)
    }

    const restored = await open('omp-replacement-pty')
    expect(customTitle()).toBe('Media Engine Orch')
    await restored.runtime.renameTerminal(restored.handle, null)
    expect(customTitle()).toBeNull()
    expect(renameTerminal).toHaveBeenLastCalledWith('host-tab', null)
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      restored.runtime.onPtyExit('omp-replacement-pty', 0)
    }

    await open('omp-cleared-pty')
    expect(customTitle()).toBeNull()
  })
})

describe('terminal rename display', () => {
  it('keeps an orphan terminal name once a tab adopts it', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'orphan-pty',
          incarnationId: 'orphan-incarnation',
          terminalHandle: 'term_orphan',
          title: 'bash',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })
    const before = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
    runtime.onPtyData('orphan-pty', '\x1b]0;bash\x07', Date.now())
    await runtime.renameTerminal('term_orphan', 'Recovered worker')

    const adopted = await runtime.adoptTerminalOrphans({
      worktree: `id:${TEST_WORKTREE_ID}`,
      expectedTopologyRevision: before.topologyRevisions?.[TEST_WORKTREE_ID] ?? 0,
      claims: [
        {
          terminal: 'term_orphan',
          ptyId: 'orphan-pty',
          incarnationId: 'orphan-incarnation',
          tabId: 'recovered-tab',
          leafId: HEADLESS_LEAF_ID
        }
      ]
    })

    await expect(runtime.showTerminal('term_orphan')).resolves.toMatchObject({
      title: 'Recovered worker'
    })
    expect(
      adopted.snapshot.tabs.find(
        (tab) => tab.type === 'terminal' && tab.parentTabId === 'recovered-tab'
      )
    ).toMatchObject({ title: 'Recovered worker' })
  })
})
