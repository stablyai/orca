import './orca-runtime-test-lifecycle.spec'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { describe, expect, it, vi } from 'vitest'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst, committingSpawn } from './bind-first-pane.test-fixture'
import { buildRuntimeMobileAgentStatus } from './runtime-mobile-agent-status-builder'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

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
  it('does not recreate a closed persisted tab from a surviving PTY record', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    const runtime = new OrcaRuntimeService(runtimeStore)
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)
    runtime.setPtyController({
      spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'surviving-pty' }))),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    setSession({ ...getSession(), tabsByWorktree: { [TEST_WORKTREE_ID]: [] } })
    runtimeStore.setWorkspaceSession.mockClear()

    await runtime.renameTerminal(created.handle, 'Late rename')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(runtimeStore.setWorkspaceSession).not.toHaveBeenCalled()
  })
})

describe('terminal rename display', () => {
  it('reveals a renamed background terminal under its name', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'background-pty' })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      presentation: 'background'
    })
    runtime.onPtyData('background-pty', '\x1b]0;bash\x07', Date.now())

    await runtime.renameTerminal(created.handle, 'Review worker')
    await runtime.focusTerminal(created.handle)

    expect(notifier.revealTerminalSession.mock.calls.at(-1)?.[1]).toMatchObject({
      title: 'Review worker'
    })
  })

  it('shows an orphan terminal under its new name', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.registerPty('orphan-pty', TEST_WORKTREE_ID)
    runtime.onPtyData('orphan-pty', '\x1b]0;bash\x07', Date.now())
    const orphan = (await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals.find(
      (terminal) => terminal.ptyId === 'orphan-pty'
    )
    if (!orphan?.orphaned) {
      throw new Error('expected an orphan terminal')
    }

    await runtime.renameTerminal(orphan.handle, 'Recovered worker')

    await expect(runtime.showTerminal(orphan.handle)).resolves.toMatchObject({
      title: 'Recovered worker'
    })
  })

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

describe('terminal view rename characterization', () => {
  function notifier(renameTerminal: RuntimeNotifier['renameTerminal']): RuntimeNotifier {
    return {
      worktreesChanged() {},
      reposChanged() {},
      activateWorktree() {},
      createTerminal() {},
      splitTerminal() {},
      renameTerminal,
      focusTerminal() {},
      closeTerminal() {},
      terminalFitOverrideChanged() {},
      terminalDriverChanged() {}
    }
  }
  it('keeps rename persistence before the current notifier with its own receiver', async () => {
    // Switch-on, main's layout says which tab holds the terminal; that layout lives in a store.
    const runtime = new OrcaRuntimeService(
      ORCA_LAYOUT_OWNER_IS_MAIN ? partialRuntimeStore() : undefined
    )
    bindPaneFirst(runtime, {
      worktreeId: 'folder-workspace',
      tabId: 'host-tab',
      leafId: '00000000-0000-4000-8000-000000000002',
      ptyId: 'rename-pty'
    })
    const pty = runtime['recordPtyWorktree']('rename-pty', 'folder-workspace', {
      tabId: 'host-tab'
    })
    const handle = runtime['issuePtyHandle'](pty)
    const receivers: OrcaRuntimeService[] = []
    const events: string[] = []
    const replacement = notifier(function (this: RuntimeNotifier, tabId, title) {
      expect(this).toBe(replacement)
      expect([tabId, title]).toEqual(['host-tab', 'Pinned'])
      events.push('replacement')
    })
    runtime.setNotifier(notifier(() => events.push('original')))
    runtime['persistHeadlessTerminalTitle'] = function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args).toEqual(['folder-workspace', 'host-tab', 'Pinned'])
      events.push('persist')
      runtime.setNotifier(replacement)
    }
    runtime['touchMobileSessionSnapshotsForPty'] = function (this: OrcaRuntimeService, ptyId) {
      receivers.push(this)
      expect(ptyId).toBe('rename-pty')
      expect(pty.title).toBeNull()
      events.push('touch')
    }
    await expect(runtime.renameTerminal(handle, 'Pinned')).resolves.toEqual({
      handle,
      tabId: 'host-tab',
      title: 'Pinned'
    })
    expect(events).toEqual(['touch', 'persist', 'replacement'])
    expect(receivers).toEqual([runtime, runtime])
    runtime.onPtyExit('rename-pty', 0)
  })
})

describe('terminal query erased boundary regressions', () => {
  // Pane getter changes per read to catch internally inconsistent summaries (L80); ordinary records do not.
  it('summarizes from one read of the pane, though a later read would differ', () => {
    class SummaryRuntime extends OrcaRuntimeService {
      summarize() {
        const pty = this.recordPtyWorktree('changing-binding', 'missing', { connected: false })
        pty.tabId = 'tab'
        pty.surfaceRecordedAtGraphSequence = 1
        let reads = 0
        Object.defineProperty(pty, 'paneKey', {
          get: () => (++reads === 1 ? null : 'tab:00000000-0000-4000-8000-000000000001')
        })
        const issueHandle = vi.fn(() => 'handle')
        Object.defineProperty(this, 'issuePtyHandle', { value: issueHandle })
        expect(this.buildPtyTerminalSummary(pty, new Map())).toMatchObject({
          orphaned: true,
          tabId: 'pty:changing-binding'
        })
        expect(reads).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 0 : 1)
        expect(issueHandle).toHaveBeenCalledExactlyOnceWith(pty)
      }
    }
    new SummaryRuntime(null).summarize()
  })

  it('dispatches destructive removal through the Root provider override', async () => {
    class TeardownRuntime extends OrcaRuntimeService {
      readonly providerReads = vi.fn()
      override getLocalProvider() {
        this.providerReads(this, arguments.length)
        return null
      }
      remove(connectionId?: string) {
        return this.stopPtysForDestructiveWorktreeRemoval('folder:notes', { connectionId })
      }
    }
    const runtime = new TeardownRuntime(null)
    await expect(runtime.remove()).rejects.toThrow('PTY provider unavailable')
    expect(runtime.providerReads).toHaveBeenCalledExactlyOnceWith(runtime, 0)
    runtime.providerReads.mockClear()
    await expect(runtime.remove('ssh-host')).rejects.toThrow('PTY provider unavailable')
    expect(runtime.providerReads).not.toHaveBeenCalled()
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

  it('keeps the first clock of a shell title that inventory replays after the hook', () => {
    const runtime = makeRuntime()
    const now = vi.spyOn(Date, 'now').mockReturnValue(launchAt)
    try {
      const pty = runtime['recordPtyWorktree']('replay-pty', TEST_WORKTREE_ID, { title: 'zsh' })
      pty.lastAgentStatus = 'idle'
      now.mockReturnValue(hookAt + 1_000)
      runtime['recordPtyWorktree']('replay-pty', TEST_WORKTREE_ID, { title: 'zsh' })
      expect(freshHookSession(pty)).toEqual(providerSession)

      runtime['recordPtyWorktree']('replay-pty', TEST_WORKTREE_ID, { title: 'bash' })
      expect(freshHookSession(pty)).toBeUndefined()
    } finally {
      now.mockRestore()
    }
  })

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
