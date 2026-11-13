import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { describe, expect, it, vi } from 'vitest'

import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'

import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { committingSpawn } from '../../orca-runtime-tests/bind-first-pane.test-fixture'
import { buildRuntimeMobileAgentStatus } from '../../session-lifecycle/projection/runtime-mobile-agent-status-builder'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'

describe('terminal rename before renderer graph hydration', () => {
  it.each(['Media Engine Orch', null])(
    'persists and forwards title %s across PTY replacement',
    async (title) => {
      const session = makeWorkspaceSessionWithHeadlessTerminal()
      session.tabsByWorktree[TEST_WORKTREE_ID][0].customTitle = 'Previous name'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
      const checkedStore = runtimeStore
      const runtime = new OrcaRuntimeService(checkedStore)
      const renameTerminal = vi.fn()
      runtime.setPtyController({
        spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'omp-initial-pty' }))),
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
      const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })

      await runtime.renameTerminal(created.handle, title)

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
      expect(renameTerminal).toHaveBeenCalledWith('host-tab', title)
      // Main-owned last-pane exit closes its tab; model restart with a fresh runtime over the saved session instead.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
        runtime.onPtyExit('omp-initial-pty', 0)
      }
      const restored = new OrcaRuntimeService(checkedStore)
      restored.setPtyController({
        spawn: vi.fn(committingSpawn(restored, async () => ({ id: 'omp-replacement-pty' }))),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      await restored.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
    }
  )

  it('publishes the name to paired clients while no window pane holds the terminal', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'paired-client-pty' }))),
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
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const published: RuntimeMobileSessionTabsResult[] = []
    runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot), 'paired-desktop')

    await runtime.renameTerminal(created.handle, 'Cafe24 - 44793')

    expect(
      published
        .at(-1)
        ?.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === 'host-tab')
    ).toMatchObject({ customTitle: 'Cafe24 - 44793' })
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

describe('first-turn identity under recorded title clocks (#32030)', () => {
  const launchAt = 1_800_000_000_000
  const hookAt = launchAt + 2_000
  const providerSession = { key: 'session_id' as const, id: 'first-turn' }
  const tab = {
    type: 'terminal' as const,
    id: 'tab::leaf',
    parentTabId: 'tab',
    leafId: HEADLESS_LEAF_ID,
    title: 'Terminal',
    isActive: true
  }

  function freshHookSession(pty: RuntimePtyWorktreeRecord) {
    return buildRuntimeMobileAgentStatus(
      pty,
      tab,
      'term',
      null,
      () => [
        {
          paneKey: 'tab:leaf',
          state: 'done',
          prompt: '',
          agentType: 'codex',
          connectionId: null,
          receivedAt: hookAt,
          evidenceObservedAt: hookAt,
          stateStartedAt: hookAt,
          providerSession
        }
      ],
      { getPaneKey: () => 'tab:leaf', getLeaf: () => null, getTrackedTitle: () => null }
    ).agentStatus?.providerSession
  }

  function makeRuntime() {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    return new OrcaRuntimeService(runtimeStore)
  }

  it.each(['none', 'recorded', 'osc'] as const)(
    'dates the launch title before spawn, with %s title evidence during spawn',
    async (observation) => {
      const runtime = makeRuntime()
      const now = vi.spyOn(Date, 'now').mockReturnValue(launchAt)
      runtime.setPtyController({
        spawn: vi.fn(
          committingSpawn(runtime, async () => {
            now.mockReturnValue(launchAt + 1_000)
            const pty = runtime['recordPtyWorktree'](
              'spawn-title-pty',
              TEST_WORKTREE_ID,
              observation === 'recorded' ? { title: 'bash' } : {}
            )
            if (observation === 'osc') {
              runtime['applyTrackedPtyTitle']('spawn-title-pty', 'bash', 'bash')
            }
            pty.lastAgentStatus = 'idle'
            now.mockReturnValue(hookAt + 1_000)
            return { id: 'spawn-title-pty' }
          })
        ),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      try {
        await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
          title: 'zsh',
          tabId: 'host-tab',
          leafId: HEADLESS_LEAF_ID
        })
        const pty = runtime['ptysById'].get('spawn-title-pty')!
        expect(freshHookSession(pty)).toEqual(providerSession)
        expect(pty.title).toBe({ none: 'zsh', recorded: 'bash', osc: null }[observation])
      } finally {
        now.mockRestore()
      }
    }
  )
})
