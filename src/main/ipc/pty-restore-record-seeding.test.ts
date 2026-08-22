import { describe, expect, it, vi } from 'vitest'
import {
  clearAgentHookPaneStateMock,
  registerPaneKeyAliasMock,
  registerPtyMock,
  setMigrationUnsupportedPtyMock,
  clearMigrationUnsupportedPtysForPaneKeyMock,
  clearPaneKeyAliasesForPtyMock
} from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  registerPtyHandlers,
  clearProviderPtyState,
  getPtyIdForPaneKey,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it('seeds cold restore at recovered dimensions with a legacy dimensionless fallback', async () => {
    const oscLinks = [{ row: 0, startCol: 0, endCol: 8, uri: 'https://example.com/restored' }]
    const coldRestore = {
      scrollback: 'restored history\r\n',
      cwd: '/projects/restored',
      cols: 132,
      rows: 43,
      oscLinks
    }
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cold-restore', coldRestore })
      .mockResolvedValueOnce({
        id: 'pty-legacy-cold-restore',
        coldRestore: { scrollback: 'legacy history\r\n', cwd: '/projects/legacy' }
      })
    setLocalPtyProvider({
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-cold-restore'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedHeadlessTerminal).toHaveBeenNthCalledWith(
      1,
      'pty-cold-restore',
      'restored history\r\n',
      { cols: 132, rows: 43 },
      { cwd: '/projects/restored', oscLinks, preferProviderIfExisting: true }
    )

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedHeadlessTerminal).toHaveBeenNthCalledWith(
      2,
      'pty-legacy-cold-restore',
      'legacy history\r\n',
      undefined,
      { cwd: '/projects/legacy', oscLinks: undefined, preferProviderIfExisting: true }
    )
  })
  // The relay's reattach replay is routed around main's model by construction (attach returns it as
  // an RPC payload and deletes the still-queued bytes from the publish queue), so main is the only
  // party that can put those bytes back. These cases pin who ingests what.
  // Why a live ingest counter rather than an absent getPtyOutputSequence: a stub that reports 0 for
  // every read makes every fence assertion below hold no matter when the fence was taken.
  const replaySeedRuntime = (
    handle: string,
    overrides: Record<string, unknown> = {}
  ): { runtime: Record<string, unknown>; ingest: { sequence: number } } => {
    const ingest = { sequence: 3 }
    return {
      ingest,
      runtime: {
        setPtyController: vi.fn(),
        noteTerminalSpawnCommand: vi.fn(),
        seedHeadlessTerminal: vi.fn(),
        hasHeadlessTerminal: vi.fn(() => false),
        // Mirrors OrcaRuntimeService.appendHeadlessTerminalCatchUp: a fence that no longer matches
        // the ingest sequence means live bytes already landed, so the older tail is refused.
        appendHeadlessTerminalCatchUp: vi.fn(
          (_ptyId: string, _data: string, fence: number) => fence === ingest.sequence
        ),
        getPtyOutputSequence: vi.fn(() => ingest.sequence),
        onPtySpawned: vi.fn(),
        onPtyData: vi.fn(() => {
          ingest.sequence += 1
        }),
        onPtyExit: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => handle),
        registerPreAllocatedHandleForPty: vi.fn(),
        preAllocateHandleForPty: vi.fn(),
        ...overrides
      }
    }
  }

  const replayReattachProvider = (
    result: Record<string, unknown>,
    onSpawn?: () => void
  ): unknown => ({
    spawn: vi.fn(async () => {
      onSpawn?.()
      return result
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    onData: vi.fn(() => vi.fn()),
    onReplay: vi.fn(() => vi.fn()),
    onExit: vi.fn(() => vi.fn()),
    listProcesses: vi.fn(async () => []),
    getForegroundProcess: vi.fn(async () => null)
  })

  it('seeds the headless emulator from an SSH relay reattach replay', async () => {
    setLocalPtyProvider(
      replayReattachProvider({
        id: 'pty-ssh-reattach',
        isReattach: true,
        replay: 'relay history\r\n'
      }) as never
    )
    const { runtime } = replaySeedRuntime('handle-ssh-reattach')
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    // Why: without this seed main's model would be a strict suffix of what the renderer painted, and a later park-reveal would restore the fragment.
    expect(runtime.seedHeadlessTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.seedHeadlessTerminal).toHaveBeenCalledWith(
      'pty-ssh-reattach',
      'relay history\r\n'
    )
  })

  it('appends only the unseen replay suffix when the headless emulator already exists', async () => {
    // The in-place reconnect: the emulator survives the transport, so the fresh-emulator seed
    // no-ops and only the never-published tail may be written — re-seeding would duplicate the rest.
    setLocalPtyProvider(
      replayReattachProvider({
        id: 'ssh:host-a@@pty-7',
        isReattach: true,
        replay: 'BEFORE-OUTAGE|DURING-OUTAGE',
        replayUnseenChars: 'DURING-OUTAGE'.length
      }) as never
    )
    const { runtime, ingest } = replaySeedRuntime('handle-ssh-catchup', {
      hasHeadlessTerminal: vi.fn(() => true)
    })
    registerPtyHandlers(mainWindow as never, runtime as never)

    const response = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      sessionId: 'ssh:host-a@@pty-7'
    })

    expect(runtime.seedHeadlessTerminal).not.toHaveBeenCalled()
    // Third argument is the pre-attach ingest fence: the append is only ordered while nothing has
    // been ingested since the attach was issued.
    expect(runtime.appendHeadlessTerminalCatchUp).toHaveBeenCalledWith(
      'ssh:host-a@@pty-7',
      'DURING-OUTAGE',
      ingest.sequence
    )
    expect(runtime.appendHeadlessTerminalCatchUp).toHaveReturnedWith(true)
    // The relay's credit accounting is main's alone; the renderer must never arbitrate its paint on
    // it, and no renderer type declares it.
    expect((response as Record<string, unknown>).replayUnseenChars).toBeUndefined()
  })

  it('leaves the model untouched when the unseen length is unknown', async () => {
    // A legacy relay omits replayUnseenChars. Absent must never be read as zero, and guessing the
    // overlap by matching bytes would silently duplicate or drop a frame.
    setLocalPtyProvider(
      replayReattachProvider({
        id: 'ssh:host-a@@pty-8',
        isReattach: true,
        replay: 'BEFORE-OUTAGE|DURING-OUTAGE'
      }) as never
    )
    const { runtime } = replaySeedRuntime('handle-ssh-legacy', {
      hasHeadlessTerminal: vi.fn(() => true)
    })
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      sessionId: 'ssh:host-a@@pty-8'
    })

    expect(runtime.appendHeadlessTerminalCatchUp).not.toHaveBeenCalled()
    expect(runtime.seedHeadlessTerminal).not.toHaveBeenCalled()
  })

  it('skips the catch-up for a non-SSH pty id that reuses this handler', async () => {
    // Folder-workspace and other remote-runtime panes share this branch; their replay never took
    // the relay's around-the-model route, so appending it would duplicate bytes the model has.
    setLocalPtyProvider(
      replayReattachProvider({
        id: 'daemon-pty-9',
        isReattach: true,
        replay: 'BEFORE-OUTAGE|DURING-OUTAGE',
        replayUnseenChars: 'DURING-OUTAGE'.length
      }) as never
    )
    const { runtime } = replaySeedRuntime('handle-daemon-reattach', {
      hasHeadlessTerminal: vi.fn(() => true)
    })
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: 'daemon-pty-9' })

    expect(runtime.appendHeadlessTerminalCatchUp).not.toHaveBeenCalled()
  })

  it('fences the catch-up on the sequence read before a direct reattach spawn', async () => {
    // The other route to the same catch-up: no stable-pane owner, the session id alone drives the
    // reattach. Its fence must be taken beside that spawn for the same reason.
    const { runtime, ingest } = replaySeedRuntime('handle-ssh-direct-fence', {
      hasHeadlessTerminal: vi.fn(() => true)
    })
    const sequenceAtAttach = ingest.sequence
    setLocalPtyProvider(
      replayReattachProvider(
        {
          id: 'ssh:host-a@@pty-10',
          isReattach: true,
          replay: 'BEFORE-OUTAGE|DURING-OUTAGE',
          replayUnseenChars: 'DURING-OUTAGE'.length
        },
        () => {
          ingest.sequence += 1
        }
      ) as never
    )
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      sessionId: 'ssh:host-a@@pty-10'
    })

    expect(runtime.appendHeadlessTerminalCatchUp).toHaveBeenCalledWith(
      'ssh:host-a@@pty-10',
      'DURING-OUTAGE',
      sequenceAtAttach
    )
    expect(runtime.appendHeadlessTerminalCatchUp).toHaveReturnedWith(false)
  })

  it('fences the catch-up on the sequence read before a pre-adoption attach', async () => {
    // The stable-pane reconnect adopts BEFORE the spawn body runs, with awaits in between: bytes the
    // relay published after the attach can be ingested first, and the withheld tail predates them.
    // Read the fence late and it equals the already-advanced sequence, so an out-of-order append
    // looks legal; taken beside the attach it no longer matches and the runtime refuses.
    const connectionId = 'ssh-catchup-fence'
    const tabId = 'tab-catchup-fence'
    const leafId = '55555555-5555-4555-8555-555555555555'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-ssh::/remote/catchup-fence'
    const ptyId = `ssh:${connectionId}@@relay-pty`
    const { runtime, ingest } = replaySeedRuntime('handle-catchup-fence', {
      hasHeadlessTerminal: vi.fn(() => true),
      resolveTerminalPane: vi.fn(() => ({
        handle: 'handle-catchup-fence',
        tabId,
        leafId,
        ptyId,
        worktreeId
      })),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' }))
    })
    const sequenceAtAttach = ingest.sequence
    registerSshPtyProvider(
      connectionId,
      replayReattachProvider(
        {
          id: ptyId,
          isReattach: true,
          replay: 'BEFORE-OUTAGE|DURING-OUTAGE',
          replayUnseenChars: 'DURING-OUTAGE'.length
        },
        () => {
          // Live bytes crossing the data socket while the attach RPC is in flight.
          ingest.sequence += 1
        }
      ) as never
    )

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)

      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/remote/catchup-fence',
        connectionId,
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })

      expect(runtime.appendHeadlessTerminalCatchUp).toHaveBeenCalledWith(
        ptyId,
        'DURING-OUTAGE',
        sequenceAtAttach
      )
      expect(runtime.appendHeadlessTerminalCatchUp).toHaveReturnedWith(false)
    } finally {
      unregisterSshPtyProvider(connectionId)
      clearProviderPtyState(ptyId)
    }
  })

  it('omits the main-internal replay credit from a deduped pane spawn reply', async () => {
    // The runtime pane create resolves the reservation; a pty:spawn racing it for the same pane
    // returns that payload verbatim, so the strip has to sit at the resolve — a per-return-site
    // strip leaves this route (and the next one added) publishing the field to the renderer.
    const connectionId = 'ssh-dedupe-strip'
    const tabId = 'tab-dedupe-strip'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const paneKey = makePaneKey(tabId, leafId)
    const worktreeId = 'repo-ssh::/remote/dedupe-strip'
    const ptyId = `ssh:${connectionId}@@relay-pty-dedupe`
    let controller: { spawn?: (opts: Record<string, unknown>) => Promise<unknown> } | null = null
    const { runtime } = replaySeedRuntime('handle-dedupe-strip', {
      setPtyController: vi.fn((next: typeof controller) => {
        controller = next
      }),
      hasHeadlessTerminal: vi.fn(() => true),
      resolveTerminalPane: vi.fn(() => ({
        handle: 'handle-dedupe-strip',
        tabId,
        leafId,
        ptyId,
        worktreeId
      })),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' }))
    })
    let releaseSpawn!: () => void
    let spawnStarted!: () => void
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    const spawnEntered = new Promise<void>((resolve) => {
      spawnStarted = resolve
    })
    const gatedSpawn = vi.fn(async () => {
      spawnStarted()
      await spawnGate
      return {
        id: ptyId,
        isReattach: true,
        replay: 'BEFORE-OUTAGE|DURING-OUTAGE',
        replayUnseenChars: 'DURING-OUTAGE'.length
      }
    })
    registerSshPtyProvider(connectionId, {
      ...(replayReattachProvider({}) as Record<string, unknown>),
      spawn: gatedSpawn
    } as never)

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)

      const runtimeSpawn = controller!.spawn!({
        cols: 80,
        rows: 24,
        cwd: '/remote/dedupe-strip',
        connectionId,
        worktreeId,
        tabId,
        leafId,
        preAllocatedHandle: 'handle-dedupe-strip'
      })
      // The reservation exists once the provider spawn is in flight, so the racing IPC call below
      // takes the dedupe early-return instead of starting a second spawn.
      await spawnEntered
      const dedupedSpawn = handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/remote/dedupe-strip',
        connectionId,
        worktreeId,
        tabId,
        leafId,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: tabId,
          ORCA_WORKTREE_ID: worktreeId
        }
      })
      releaseSpawn()
      await runtimeSpawn
      const deduped = (await dedupedSpawn) as Record<string, unknown>

      // Proves this really is the forwarded reservation payload and not a fresh spawn result.
      expect(gatedSpawn).toHaveBeenCalledTimes(1)
      expect(deduped.id).toBe(ptyId)
      expect(deduped.replay).toBe('BEFORE-OUTAGE|DURING-OUTAGE')
      expect(deduped.isReattach).toBe(true)
      expect('replayUnseenChars' in deduped).toBe(false)
    } finally {
      unregisterSshPtyProvider(connectionId)
      clearProviderPtyState(ptyId)
    }
  })

  // STA repro (post-restart blind orchestrator): reattach restore payloads
  // arrive as spawn RPC results, never through onPtyData, so without record
  // seeding `terminal list` reported connected terminals with empty
  // title/preview/lastOutputAt after every relaunch and `terminal read`
  // returned a zero-line tail for a running session.
  it('leaves the runtime reporting preview and title after a reattach spawn (restart restore)', async () => {
    const worktreeId = 'repo-restore::/tmp/restore-records'
    const tabId = 'tab-restore-records'
    const leafId = '55555555-5555-4555-8555-555555555555'
    const ptyId = `${worktreeId}@@session-restore-1`
    const session = getDefaultWorkspaceSession()
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: () => {},
      getRepos: () => [
        {
          id: 'repo-restore',
          path: '/tmp/restore-records',
          displayName: 'restore',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => []
    } as never)
    runtime.attachWindow(1)
    // The restored window graph still knows the persisted ptyId binding.
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId, worktreeId, title: '', activeLeafId: leafId, layout: null }],
      leaves: [{ tabId, worktreeId, leafId, paneRuntimeId: 1, ptyId, paneTitle: null, title: '' }]
    })
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: ptyId,
        isReattach: true,
        snapshot: '\x1b[32m$\x1b[0m npm test\r\n\x1b[1mall 42 tests passed\x1b[0m\r\n',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'restored-agent-title'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => [{ id: ptyId, cwd: '/tmp/restore-records' }]),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(mainWindow as never, runtime)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, worktreeId, tabId, leafId })

    const { terminals } = await runtime.listTerminals(`id:${worktreeId}`)
    expect(terminals).toHaveLength(1)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('$ npm test')
    expect(terminal.preview).toContain('all 42 tests passed')
    expect(terminal.title).toBe('restored-agent-title')
    // Seeded scrollback is historical — recency must come only from live bytes.
    expect(terminal.lastOutputAt).toBeNull()
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['$ npm test', 'all 42 tests passed'])
  })
  it('seeds restore records even when the renderer pre-signals serializer ownership', async () => {
    const tabId = 'tab-gated-restore'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const paneKey = makePaneKey(tabId, leafId)
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-gated-reattach',
        isReattach: true,
        snapshot: 'gated snapshot\r\n',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'gated-title'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      seedTerminalRestoreTail: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      registerPty: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-gated-restore'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const gen = await handlers.get('pty:declarePendingPaneSerializer')!(null, { paneKey })

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-gated',
      tabId,
      leafId,
      env: { ORCA_PANE_KEY: paneKey }
    })

    // The renderer owns the emulator snapshot here — but the list/read records
    // are main-side only, so the record seed must still run.
    expect(runtime.seedHeadlessTerminal).not.toHaveBeenCalled()
    expect(runtime.seedTerminalRestoreTail).toHaveBeenCalledWith('pty-gated-reattach', {
      text: 'gated snapshot\r\n',
      lastTitle: 'gated-title'
    })
    await handlers.get('pty:clearPendingPaneSerializer')!(null, { paneKey, gen })
  })
  it('seeds restore records from a cold-restore payload including its checkpoint title', async () => {
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: 'pty-cold-restore-records',
        coldRestore: {
          scrollback: 'cold restored history\r\n',
          cwd: '/projects/restored',
          cols: 132,
          rows: 43,
          lastTitle: 'checkpoint-title'
        }
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      seedTerminalRestoreTail: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'handle-cold-restore-records'),
      registerPreAllocatedHandleForPty: vi.fn(),
      preAllocateHandleForPty: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24 })

    expect(runtime.seedTerminalRestoreTail).toHaveBeenCalledWith('pty-cold-restore-records', {
      text: 'cold restored history\r\n',
      lastTitle: 'checkpoint-title'
    })
  })
  // Why windowless: `orca serve`/CLI runtime creation is the topology that most
  // needs informative records — its controller.spawn path must seed them too.
  it('seeds restore records for a runtime-controller created terminal (headless reattach)', async () => {
    const worktreeId = 'repo-restore::/tmp/restore-records'
    const ptyId = `${worktreeId}@@session-headless-1`
    const session = getDefaultWorkspaceSession()
    const repo = {
      id: 'repo-restore',
      path: '/tmp/restore-records',
      displayName: 'restore',
      badgeColor: '#000000',
      addedAt: 0
    }
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => session,
      setWorkspaceSession: () => {},
      getRepo: (repoId: string) => (repoId === repo.id ? repo : undefined),
      getRepos: () => [repo],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: () => undefined as never,
      removeWorktreeMeta: () => {},
      getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
      getProjects: () => [],
      persistPtyBinding: vi.fn()
    } as never)
    // Why: selector resolution shells out to git for real repos; prime the
    // resolved-worktree cache so this headless fixture resolves offline.
    const worktreeResolutionInternals = runtime as unknown as {
      buildResolvedWorktreeFromId(id: string): unknown
      resolvedWorktreeCache: {
        worktrees: unknown[]
        platformByRepoId: Map<string, NodeJS.Platform>
        expiresAt: number
      } | null
    }
    worktreeResolutionInternals.resolvedWorktreeCache = {
      worktrees: [worktreeResolutionInternals.buildResolvedWorktreeFromId(worktreeId)],
      platformByRepoId: new Map([[repo.id, process.platform]]),
      expiresAt: Date.now() + 60_000
    }
    setLocalPtyProvider({
      spawn: vi.fn(async () => ({
        id: ptyId,
        isReattach: true,
        snapshot: 'headless reattach history\r\n$ ',
        snapshotCols: 80,
        snapshotRows: 24,
        lastTitle: 'headless-restored-title'
      })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => [{ id: ptyId, cwd: '/tmp/restore-records' }]),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    registerPtyHandlers(mainWindow as never, runtime, undefined, undefined, undefined, {
      persistPtyBinding: vi.fn()
    } as never)

    const created = await runtime.createTerminal(`id:${worktreeId}`, {
      presentation: 'background'
    })
    expect(created.ptyId).toBe(ptyId)

    const { terminals } = await runtime.listTerminals(`id:${worktreeId}`)
    const terminal = terminals.find((entry) => entry.ptyId === ptyId)
    expect(terminal).toBeDefined()
    expect(terminal!.preview).toContain('headless reattach history')
    expect(terminal!.title).toBe('headless-restored-title')
    expect(terminal!.lastOutputAt).toBeNull()
    const read = await runtime.readTerminal(created.handle)
    expect(read.tail).toContain('headless reattach history')
  })
  it('upgrades legacy numeric pane keys when the spawn metadata proves the stable leaf', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: 'tab-1:0' }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: stablePaneKey
      })
    )
    expect(registerPaneKeyAliasMock).toHaveBeenCalledWith(
      'tab-1:0',
      stablePaneKey,
      expect.any(String),
      expect.any(Number),
      { authorityVerified: true }
    )
    expect(clearMigrationUnsupportedPtysForPaneKeyMock).toHaveBeenCalledWith(stablePaneKey)
    expect(setMigrationUnsupportedPtyMock).not.toHaveBeenCalled()

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: stablePaneKey
      })
    )
    expect(clearMigrationUnsupportedPtysForPaneKeyMock).toHaveBeenCalledWith(stablePaneKey)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: makePaneKey('tab-2', leafId) }
    })

    expect(registerPtyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        paneKey: null
      })
    )
  })
  it('does not let an old PTY teardown clear a newer pane-key owner', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)

    const first = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }
    const second = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(second.id)
    clearAgentHookPaneStateMock.mockClear()
    clearProviderPtyState(first.id)

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(second.id)
    expect(clearAgentHookPaneStateMock).not.toHaveBeenCalledWith(stablePaneKey)

    clearProviderPtyState(second.id)
    expect(getPtyIdForPaneKey(stablePaneKey)).toBeUndefined()
    expect(clearAgentHookPaneStateMock).toHaveBeenCalledWith(stablePaneKey)
  })
  it('does not let restart-era alias cleanup clear a newer pane-key owner', async () => {
    registerPtyHandlers(mainWindow as never)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const stablePaneKey = makePaneKey('tab-1', leafId)

    const current = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId,
      env: { ORCA_PANE_KEY: stablePaneKey }
    })) as { id: string }

    expect(getPtyIdForPaneKey(stablePaneKey)).toBe(current.id)
    clearPaneKeyAliasesForPtyMock.mockClear()

    clearProviderPtyState('old-pty-without-forward-pane-key')

    const cleanupOptions = clearPaneKeyAliasesForPtyMock.mock.calls.find(
      ([ptyId]) => ptyId === 'old-pty-without-forward-pane-key'
    )?.[1]
    expect(cleanupOptions?.shouldClearStablePaneKey(stablePaneKey)).toBe(false)
  })
})
