import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  advertisedUrlWatcher,
  getDefaultWorkspaceSession
} from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('never lets an old handle adopt a replacement PTY incarnation', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    let process = {
      id: 'reused-pty-id',
      incarnationId: 'inc-old',
      terminalHandle: 'term_old',
      title: 'old',
      cwd: TEST_WORKTREE_PATH,
      worktreeId: TEST_WORKTREE_ID,
      wslDistro: null
    }
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [process]
    })
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_old', incarnationId: 'inc-old' })]
    })

    process = { ...process, incarnationId: 'inc-new', terminalHandle: 'term_new', title: 'new' }
    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_old',
            ptyId: process.id,
            incarnationId: 'inc-new',
            tabId: 'stale-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_stale')
    await expect(runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).resolves.toMatchObject({
      terminals: [expect.objectContaining({ handle: 'term_new', incarnationId: 'inc-new' })]
    })
  })

  it('rejects a proposed visual surface occupied by a different PTY', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [TEST_WORKTREE_ID]: [] }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'occupied',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'occupied-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'visual-pty'
        }
      ]
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'orphan-pty',
          incarnationId: 'inc-orphan',
          terminalHandle: 'term_orphan',
          title: 'orphan',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_orphan',
            ptyId: 'orphan-pty',
            incarnationId: 'inc-orphan',
            tabId: 'occupied-tab',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_surface_occupied')
  })

  it('rejects ambiguous duplicate persisted bindings before idempotence', async () => {
    const duplicateTab = (id: string) => ({
      id,
      ptyId: 'duplicate-pty',
      worktreeId: TEST_WORKTREE_ID,
      title: id,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [duplicateTab('duplicate-a'), duplicateTab('duplicate-b')]
      },
      terminalLayoutsByTabId: {
        'duplicate-a': {
          root: { type: 'leaf', leafId: HEADLESS_LEAF_ID },
          activeLeafId: HEADLESS_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_LEAF_ID]: 'duplicate-pty' }
        },
        'duplicate-b': {
          root: { type: 'leaf', leafId: HEADLESS_SECOND_LEAF_ID },
          activeLeafId: HEADLESS_SECOND_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [HEADLESS_SECOND_LEAF_ID]: 'duplicate-pty' }
        }
      },
      terminalPtyIncarnationsByPaneKey: {
        [`duplicate-a:${HEADLESS_LEAF_ID}`]: 'inc-duplicate',
        [`duplicate-b:${HEADLESS_SECOND_LEAF_ID}`]: 'inc-duplicate'
      }
    })
    const runtime = new OrcaRuntimeService({ ...runtimeStore, flushOrThrow: vi.fn() } as never)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'duplicate-pty',
          incarnationId: 'inc-duplicate',
          terminalHandle: 'term_duplicate',
          title: 'duplicate',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ]
    })

    await expect(
      runtime.adoptTerminalOrphans({
        worktree: `id:${TEST_WORKTREE_ID}`,
        expectedTopologyRevision: 0,
        claims: [
          {
            terminal: 'term_duplicate',
            ptyId: 'duplicate-pty',
            incarnationId: 'inc-duplicate',
            tabId: 'duplicate-a',
            leafId: HEADLESS_LEAF_ID
          }
        ]
      })
    ).rejects.toThrow('terminal_orphan_competing_owner')
  })

  it('does not adopt a discovered terminal handle already bound to another live PTY', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writesByPty = new Map<string, string[]>()
    runtime.setPtyController({
      write: (ptyId, data) => {
        writesByPty.set(ptyId, [...(writesByPty.get(ptyId) ?? []), data])
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-victim',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        },
        {
          id: 'pty-imposter',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_victim'
        }
      ]
    })

    const listed = await runtime.listTerminals()
    const handles = listed.terminals.map((terminal) => terminal.handle)
    expect(handles).toContain('term_victim')
    expect(new Set(handles).size).toBe(handles.length)

    await expect(
      runtime.sendTerminal('term_victim', { text: 'for victim' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writesByPty.get('pty-victim')).toEqual(['for victim'])
    expect(writesByPty.has('pty-imposter')).toBe(false)
  })

  it('keeps an already-bound terminal handle when discovery reports a different exported one', async () => {
    const runtime = new OrcaRuntimeService(store)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'pty-1',
          cwd: TEST_WORKTREE_PATH,
          title: 'claude',
          terminalHandle: 'term_from_env'
        }
      ]
    })
    runtime.registerPreAllocatedHandleForPty('pty-1', 'term_already_bound')

    const listed = await runtime.listTerminals()
    expect(listed.terminals[0]?.handle).toBe('term_already_bound')
    await expect(
      runtime.sendTerminal('term_already_bound', { text: 'still routed' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual(['still routed'])
    // the reported-but-not-adopted handle must not resolve to the live pty
    await expect(runtime.readTerminal('term_from_env')).rejects.toThrow()
  })

  it('binds advertised URLs for renderer-restored PTYs that skip registerPty', () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-restored')
    runtime.onPtyData('pty-restored', 'Network: https://restored.example.com:3001/\n', 100)

    expect(advertisedUrlWatcher.lookup(TEST_WORKTREE_ID, 3001)?.origin).toBe(
      'https://restored.example.com:3001'
    )
  })

  it('keeps preallocated terminal handles valid across renderer reloads', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    syncSinglePty(runtime, null)
    runtime.onPtyData('pty-1', 'after reload\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after reload'])
  })

  it('keeps preallocated terminal handles valid when a reload graph omits the live leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after omitted leaf\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after omitted leaf'])
  })

  it('keeps preallocated terminal handles valid after graph unavailable during reload', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markGraphUnavailable(1)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after unavailable\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after unavailable'])
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(runtime.sendTerminal(handle, { text: 'still writable' })).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('preserves runtime-created PTY process identity after graph unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const incarnation = runtime.getTerminalProcessIncarnation(handle)

    runtime.markGraphUnavailable(1)

    expect(runtime.getTerminalProcessIncarnation(handle)).toBe(incarnation)
  })

  it('preserves PTY process identity while a renderer surface detaches and reattaches', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({
        id: 'pty-bg',
        incarnationId: 'incarnation-bg'
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const [tabId, leafId] = created.paneKey?.split(':') ?? []
    if (!tabId || !leafId) {
      throw new Error('expected stable pane identity')
    }
    const syncSurface = (ptyId: string | null): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId,
            paneTitle: 'Codex'
          }
        ]
      })
    }

    syncSurface('pty-bg')
    await runtime.listTerminals()
    const before = runtime.getTerminalProcessIncarnation(created.handle)
    syncSurface(null)
    syncSurface('pty-bg')
    await runtime.listTerminals()

    expect(runtime.getTerminalProcessIncarnation(created.handle)).toBe(before)

    runtime.registerPty('pty-bg', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-replacement'
    })
    expect(runtime.getTerminalProcessIncarnation(created.handle)).not.toBe(before)
  })

  it('recognizes runtime-created PTY handles with agent launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex package-cache cleanup'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('does not treat a bare Cursor Agent native title as a running agent session', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    // Why: the native title is identity, not liveness — Cursor never decorates it, so it
    // reads the same whether cursor-agent is parked or long gone. Sends auto-submit Enter,
    // so identity alone must not unlock one.
    syncSinglePty(runtime, 'pty-1', { tabTitle: 'bash', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('does not authorize an OpenCode marker left on a shell pane', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'OC | zsh' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: false,
      status: null
    })
  })

  it('authorizes a hookless OpenCode marker with an OpenCode foreground process', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'opencode'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'OC | Native session' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'idle'
    })
  })

  it('does not authorize an OpenCode marker left on a runtime PTY shell', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'OC | zsh'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toEqual({
      handle,
      isRunningAgent: false,
      status: null
    })
  })

  // Why: a leaf with no PTY is the same no-evidence case as an unreadable foreground —
  // nothing was even asked, so the bare title is all that is left. The corroborating
  // foreground here is deliberately unreachable: no ptyId means no read.
  it('does not treat a bare Cursor title as an agent on a leaf with no pty', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'cursor-agent'
    })
    syncSinglePty(runtime, null, { tabTitle: 'bash', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: a renderer can push the bare title straight onto the pane, skipping the stale
  // clear the other tests drive. Arriving that way it lands on top of a `working` status
  // the spinner left behind, so the pane looks doubly like an agent — and is still just a
  // shell. The tab is left untitled so the bare title is the only evidence in play: the
  // refusal is decided at the foreground, and the stale-status gate is held shut behind it.
  it('does not let a renderer-pushed bare Cursor title revive stale agent status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    syncSinglePty(runtime, 'pty-1', { tabTitle: '' })
    runtime.onPtyData('pty-1', '\x1b]0;⠋ Cursor Agent\x07', 100)
    syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(terminal.title).toBe('Cursor Agent')
    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: pins the outer catch, not a reachable state — the production controller
  // (src/main/ipc/pty.ts) already normalizes provider failures, a dropped SSH channel
  // included, to null before this sees them. Nothing else here makes the read throw.
  it('does not treat a bare Cursor title as an agent when the foreground read throws', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => {
        throw new Error('ssh channel closed')
      }
    })
    syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  // Why: cursor-agent is a node program, so `node` in the foreground plus a Cursor title
  // looks like corroboration. It is not — the wrapper retry has to resolve a real agent
  // name, and timing out means it never did.
  it('does not treat a bare Cursor title as an agent behind a wrapper foreground', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'node'
      })
      syncSinglePty(runtime, 'pty-1', { tabTitle: '', paneTitle: 'Cursor Agent' })
      const [terminal] = (await runtime.listTerminals()).terminals

      const running = runtime.isTerminalRunningAgent(terminal.handle)
      await vi.advanceTimersByTimeAsync(7_000)
      await expect(running).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recognize runtime-created Claude agents management screens as agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('uses stale runtime-created PTY status when there is no title or foreground evidence', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    runtime.setPtyController(null)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })
})
