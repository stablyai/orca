import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as adoption from './pty/pane/adopt-stable'
import * as runtimePreflight from './pty/runtime/spawn-preflight'
import * as ipcPreflight from './pty/ipc/spawn-preflight'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import type * as JcodeRuntimeDir from '../../shared/jcode-runtime-dir'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { TerminalCreateOptions } from '../runtime/runtime-terminal-contracts'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import { setupPtyIpcSuite } from './pty/pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { createPaneBindingStore, launchRacePane } from './pty/pty-launch-race-test-fixture'
import { clearProviderPtyState } from './pty/provider/state-cleanup'
import * as reservations from './pty/pane/spawn-reservation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('electron', () => import('./pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('node-pty', () => import('./pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// Why: the host lane's real mkdir is thread-pool I/O, so a joiner could miss flushMacrotasks' turns under load.
vi.mock('../../shared/jcode-runtime-dir', async (importOriginal) => {
  const actual = await importOriginal<typeof JcodeRuntimeDir>()
  return {
    ...actual,
    ensureJcodeRuntimeDir: async (paneKey: string) => actual.buildJcodeRuntimeDirEnv(paneKey)
  }
})

const consumeExited = adoption.consumeExitedPaneOperation
const N = 4
const treePasses = ORCA_LAYOUT_OWNER_IS_MAIN ? 2 : 1
const snapshot = 'final output\r\n'.repeat(256)

function gate() {
  let release = () => {}
  const promise = new Promise<void>((done) => {
    release = done
  })
  return { promise, release }
}

// Count actual comparisons/visited nodes without replacing lookup or traversal decisions.
function observeSession(
  store: Pick<ReturnType<typeof createPaneBindingStore>, 'getWorkspaceSession'>
) {
  const counts = { tabs: 0, nodes: 0, reads: 0, fallback: false }
  const arrays = new WeakSet<object>()
  const nodes = new WeakSet<object>()
  const observeTree = (node: TerminalPaneLayoutNode | null) => {
    if (!node || nodes.has(node)) {
      return
    }
    nodes.add(node)
    if (node.type === 'split') {
      observeTree(node.first)
      observeTree(node.second)
    }
    const type = node.type
    Object.defineProperty(node, 'type', {
      enumerable: true,
      configurable: true,
      get: () => {
        if (counts.fallback) {
          counts.nodes++
        }
        return type
      }
    })
  }
  const read = store.getWorkspaceSession.bind(store)
  vi.spyOn(store, 'getWorkspaceSession').mockImplementation(() => {
    counts.reads++
    const session = read()
    for (const tabs of Object.values(session.tabsByWorktree)) {
      if (arrays.has(tabs)) {
        continue
      }
      arrays.add(tabs)
      vi.spyOn(tabs, 'find').mockImplementation((predicate, thisArg) =>
        Array.prototype.find.call(tabs, (tab, index) => {
          counts.tabs++
          return predicate.call(thisArg, tab, index, tabs)
        })
      )
    }
    for (const layout of Object.values(session.terminalLayoutsByTabId)) {
      observeTree(layout.root)
    }
    return session
  })
  return counts
}

function mapRoots() {
  const roots = [
    ...reservations.pendingRuntimePaneCreatesByOwnerKey.values(),
    ...reservations.paneSpawnReservationsByOwnerKey.values()
  ]
  const payloads = new Set<object>()
  for (const root of roots) {
    const result = 'count' in root ? root.result : root.outcome?.result
    if (result?.coldRestore) {
      payloads.add(result.coldRestore)
    }
    const canonical = root.operation?.acquisition?.reservation.outcome?.result.coldRestore
    if (canonical) {
      payloads.add(canonical)
    }
  }
  return { roots: roots.length, payloads: payloads.size }
}

describe('shared terminal spawn operation/retention scaling contract', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  async function run(
    size: number,
    dimension: 'tabs' | 'layout' | 'callers' | 'panes',
    outcome: 'success' | 'exit' | 'absent' | 'cancelled' | 'refused' | 'successor' = 'success'
  ) {
    const panes = Array.from({ length: dimension === 'panes' ? size : 1 }, (_, i) =>
      launchRacePane(
        `scale-${dimension}-${size}-${outcome}-${i}`,
        `94949494-9494-4494-8494-${String(i).padStart(12, '0')}`
      )
    )
    const binding = createPaneBindingStore()
    type WriteListener = Parameters<NonNullable<RuntimeStore['onWorkspaceSessionWritten']>>[0]
    const listeners = new Set<WriteListener>()
    const notify = () => {
      for (const listener of listeners) {
        listener('local')
      }
    }
    const store = {
      ...binding,
      getSettings: () => ({}),
      getWorkspaceSessionHostIds: () => ['local'] as const,
      setWorkspaceSession: (...args: Parameters<typeof binding.setWorkspaceSession>) => {
        binding.setWorkspaceSession(...args)
        notify()
      },
      persistPtyBinding: async (...args: Parameters<typeof binding.persistPtyBinding>) => {
        const accepted = await binding.persistPtyBinding(...args)
        if (accepted) {
          notify()
        }
        return accepted
      },
      onWorkspaceSessionWritten: (listener: WriteListener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
    const runtime = new OrcaRuntimeService()
    Object.assign(runtime, {
      store,
      resolveTerminalWorkspaceLaunchScope: async (selector: string) => {
        const pane = panes.find((p) => `id:${p.worktreeId}` === selector)!
        return { id: pane.worktreeId, path: pane.args.cwd, connectionId: null }
      },
      resolveAgentTerminalCreateOptions: async (_workspace: unknown, opts: TerminalCreateOptions) =>
        opts,
      resolveWorkspaceTerminalStartupCwd: (workspace: { path: string }) => workspace.path
    })
    const installed = vi.spyOn(runtime, 'setPtyController')
    registerPtyHandlers(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing IPC fixture implements the window ports reached by these handlers.
      mainWindow as never,
      runtime,
      undefined,
      undefined,
      undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: existing mutable durable Store fixture implements this flow's I/O boundary.
      store as never
    )
    const hostStart = installed.mock.calls.at(-1)?.[0]?.spawn
    if (!hostStart) {
      throw new Error('missing runtime controller')
    }
    for (const pane of panes) {
      await store.admitTerminalPane({
        type: 'createTerminalTab',
        workspace: pane.worktreeId,
        tabId: pane.tabId,
        leafId: pane.leafId
      })
      const session = store.getWorkspaceSession()
      let root: TerminalPaneLayoutNode = { type: 'leaf', leafId: pane.leafId }
      for (let i = 1; i < (dimension === 'layout' ? size : N); i++) {
        root = {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: `85858585-8585-4585-8585-${String(i).padStart(12, '0')}` },
          second: root
        }
      }
      session.terminalLayoutsByTabId[pane.tabId]!.root = root
    }
    const counts = observeSession(store)
    const exitWork = { calls: 0, tabs: 0, nodes: 0 }
    const exited = vi
      .spyOn(adoption, 'consumeExitedPaneOperation')
      .mockImplementation((...args) => {
        const before = { tabs: counts.tabs, nodes: counts.nodes }
        try {
          return consumeExited(...args)
        } finally {
          exitWork.calls++
          exitWork.tabs += counts.tabs - before.tabs
          exitWork.nodes += counts.nodes - before.nodes
        }
      })
    onTestFinished(() => exited.mockRestore())
    const hasView = runtime.hasTerminalPaneView.bind(runtime)
    vi.spyOn(runtime, 'hasTerminalPaneView').mockImplementation((...args) => {
      const found = hasView(...args)
      counts.fallback = !found
      return found
    })
    const providerGate = gate()
    const preparation = vi.spyOn(runtimePreflight, 'prepareRuntimePtySpawn').mockClear()
    const ipcPreparation = vi.spyOn(ipcPreflight, 'preparePtyIpcSpawnPreflight').mockClear()
    const commits = vi.spyOn(runtime, 'noteTerminalSpawnCommit')
    const payloads = panes.map((pane) => ({ scrollback: snapshot, cwd: pane.args.cwd }))
    const provider = vi.fn(
      async (opts: { cwd?: string; sessionId?: string; attachOnly?: boolean }) => {
        await providerGate.promise
        const index = Math.max(
          0,
          panes.findIndex((p) => p.args.cwd === opts.cwd)
        )
        return {
          id: opts.sessionId ?? `scale-pty-${index}`,
          incarnationId: `scale-inc-${index}`,
          snapshot,
          coldRestore: payloads[index],
          ...(opts.attachOnly ? { isReattach: true } : {})
        }
      }
    )
    installDaemonTestProvider({ spawn: provider })
    if (outcome === 'exit' || outcome === 'absent' || outcome === 'successor') {
      vi.spyOn(runtime, 'registerPty').mockImplementation(() => {
        throw new Error('agent_session_exited_during_start')
      })
      vi.spyOn(runtime, 'getPtyLivenessVerdict').mockReturnValue({ status: 'exited' })
    }
    if (outcome === 'refused') {
      provider.mockImplementation(async () => {
        await providerGate.promise
        throw new Error('provider_refused')
      })
    }
    const settled = vi.fn()
    const observe = (promise: Promise<unknown>) =>
      promise.then(
        (value) => {
          settled()
          return value
        },
        (error: unknown) => {
          settled()
          return error
        }
      )
    const signal = new AbortController()
    if (outcome === 'cancelled') {
      signal.abort()
    }
    const producers = panes.map((pane) =>
      observe(
        runtime.createTerminal(`id:${pane.worktreeId}`, {
          tabId: pane.tabId,
          leafId: pane.leafId,
          sessionId: `scale-pty-${panes.indexOf(pane)}`,
          presentation: 'background',
          signal: signal.signal
        })
      )
    )
    onTestFinished(async () => {
      providerGate.release()
      await Promise.all(producers)
    })
    if (outcome === 'cancelled') {
      const results = await Promise.all(producers)
      for (const result of results) {
        expect(result).toMatchObject({ message: 'client_disconnected' })
      }
      expect(provider).not.toHaveBeenCalled()
      expect(preparation).not.toHaveBeenCalled()
      expect(mapRoots()).toEqual({ roots: 0, payloads: 0 })
      return
    }
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(panes.length))
    const retained = { peakRoots: 0, peakPayloads: 0 }
    const pending = [...reservations.pendingRuntimePaneCreatesByOwnerKey.values()]
    const waiting = vi.fn()
    for (const claim of pending) {
      const promise = claim.promise
      Object.defineProperty(claim, 'promise', {
        configurable: true,
        get: () => {
          waiting()
          return promise
        }
      })
      let result = claim.result
      Object.defineProperty(claim, 'result', {
        configurable: true,
        get: () => result,
        set: (next) => {
          result = next
          const roots = mapRoots()
          retained.peakRoots = Math.max(retained.peakRoots, roots.roots)
          retained.peakPayloads = Math.max(retained.peakPayloads, roots.payloads)
        }
      })
    }
    expect(mapRoots()).toEqual({ roots: 2 * panes.length, payloads: 0 })
    // Populate after admitted producer startup; count only requests against this fixed saved snapshot.
    const session = store.getWorkspaceSession()
    for (const pane of panes) {
      const target = session.tabsByWorktree[pane.worktreeId]!.find((tab) => tab.id === pane.tabId)!
      session.tabsByWorktree[pane.worktreeId] = [
        ...Array.from({ length: (dimension === 'tabs' ? size : N) - 1 }, (_, i) => ({
          ...target,
          id: `unrelated-${i}`
        })),
        outcome === 'absent' && dimension === 'tabs' ? { ...target, id: 'absent-target' } : target
      ]
    }
    const beforeJoin = counts.tabs
    const requests = dimension === 'callers' ? size : N
    const views = panes.flatMap((pane) =>
      Array.from({ length: requests }, (_, i) => {
        const args = { ...pane.args, sessionId: `scale-pty-${panes.indexOf(pane)}` }
        return observe(
          i % 2 ? hostStart(args) : Promise.resolve(handlers.get('pty:spawn')!(null, args))
        )
      })
    )
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledTimes(requests * panes.length))
    const joinComparisons = counts.tabs - beforeJoin
    if (outcome === 'exit' || outcome === 'successor') {
      const mutate = store.runDurableMutation.bind(store)
      const root = store.getWorkspaceSession().terminalLayoutsByTabId[panes[0]!.tabId]!.root
      vi.spyOn(store, 'runDurableMutation').mockImplementation(async (write) => {
        const value = await mutate(write)
        // A retained saved view may arrive after retirement; it carries topology, no live binding.
        const layout = store.getWorkspaceSession().terminalLayoutsByTabId[panes[0]!.tabId]
        if (layout && outcome === 'exit') {
          layout.root = root
        }
        if (layout && outcome === 'successor') {
          layout.ptyIdsByLeafId = { [panes[0]!.leafId]: 'successor' }
          const session = store.getWorkspaceSession()
          session.terminalPtyIncarnationsByPaneKey ??= {}
          session.terminalPtyIncarnationsByPaneKey[makePaneKey(panes[0]!.tabId, panes[0]!.leafId)] =
            'successor-inc'
        }
        return value
      })
    }
    providerGate.release()
    const results = await Promise.all([...producers, ...views])
    expect(joinComparisons).toBe(requests * panes.length * (dimension === 'tabs' ? size : N))
    expect(settled).toHaveBeenCalledTimes((requests + 1) * panes.length)
    expect(provider.mock.calls.filter(([opts]) => !opts.attachOnly)).toHaveLength(panes.length)
    expect(provider.mock.calls.length).toBeLessThanOrEqual(3 * panes.length)
    expect(preparation).toHaveBeenCalledTimes(panes.length)
    expect(ipcPreparation).not.toHaveBeenCalled()
    expect(commits).toHaveBeenCalledTimes(outcome === 'success' ? 2 * panes.length : 0)
    expect(retained.peakPayloads).toBe(
      outcome === 'refused' || (outcome === 'absent' && dimension === 'tabs') ? 0 : panes.length
    )
    expect(retained.peakRoots).toBeLessThanOrEqual(2 * panes.length)
    expect(mapRoots()).toEqual({ roots: 0, payloads: 0 })
    for (const pane of panes) {
      const key = reservations.makePaneSpawnReservationKey(
        pane.worktreeId,
        null,
        makePaneKey(pane.tabId, pane.leafId)
      )!
      expect(reservations.pendingRuntimePaneCreatesByOwnerKey.has(key)).toBe(false)
      expect(reservations.paneSpawnReservationsByOwnerKey.has(key)).toBe(false)
    }
    const windowResults = results.slice(panes.length).filter((_, i) => (i % requests) % 2 === 0)
    const hostResults = results.slice(panes.length).filter((_, i) => (i % requests) % 2 === 1)
    if (outcome === 'exit') {
      // Host consumers scan saved tabs once; window consumers also validate the saved view.
      expect(exitWork).toEqual({
        calls: requests,
        tabs: (requests + requests / 2) * (dimension === 'tabs' ? size : N),
        nodes: treePasses * (requests / 2) * (2 * (dimension === 'layout' ? size : N) - 1)
      })
      expect(results.slice(0, panes.length)).toEqual(
        panes.map(() => expect.objectContaining({ message: 'agent_session_exited_during_start' }))
      )
      for (const result of windowResults) {
        expect(result).toMatchObject({ snapshot, isReattach: true })
      }
      for (const result of hostResults) {
        expect(result).toMatchObject({ message: 'agent_session_exited_during_start' })
      }
      expect(counts.nodes).toBe(
        treePasses * (requests / 2) * panes.length * (2 * (dimension === 'layout' ? size : N) - 1)
      )
    } else if (outcome === 'success') {
      for (const result of results.slice(0, panes.length)) {
        expect(result).toMatchObject({ ptyId: expect.stringContaining('scale-pty-') })
      }
      for (const result of windowResults) {
        expect(result).toMatchObject({ snapshot, isReattach: true })
      }
      for (const result of hostResults) {
        expect(result).toMatchObject({ id: expect.stringContaining('scale-pty-') })
        expect(result).toMatchObject({ snapshot, isReattach: true })
      }
    } else if (outcome === 'absent' || outcome === 'successor') {
      for (const result of windowResults) {
        expect(result).toMatchObject({
          message:
            dimension === 'tabs' ? 'terminal_split_source_not_found' : 'terminal_pane_owner_changed'
        })
      }
      for (const result of hostResults) {
        expect(result).toMatchObject({
          message:
            dimension === 'tabs'
              ? 'terminal_split_source_not_found'
              : outcome === 'successor'
                ? 'terminal_pane_owner_changed'
                : 'agent_session_exited_during_start'
        })
      }
      if (outcome === 'absent' && dimension === 'layout') {
        expect(exitWork).toEqual({
          calls: requests,
          tabs: (requests + requests / 2) * N,
          nodes: treePasses * (requests / 2) * (2 * size - 3)
        })
      }
    } else if (outcome === 'refused') {
      for (const result of results) {
        expect(result).toMatchObject({ message: 'provider_refused' })
      }
    }
    for (const claim of pending) {
      if (outcome !== 'refused' && !(outcome === 'absent' && dimension === 'tabs')) {
        expect(claim.result?.coldRestore).toBe(payloads[pending.indexOf(claim)])
        expect(claim.result).not.toHaveProperty('isReattach')
        expect(claim.operation?.acquisition?.reservation.outcome?.kind).toBe(
          outcome === 'success' ? 'committed' : 'registration-exited'
        )
      }
    }
    for (let i = 0; i < panes.length; i++) {
      clearProviderPtyState(`scale-pty-${i}`)
    }
    const responsePayloads = new Set(
      results
        .slice(panes.length)
        .flatMap((result) =>
          typeof result === 'object' && result !== null && 'coldRestore' in result
            ? [result.coldRestore]
            : []
        )
    )
    if (outcome === 'success' || outcome === 'exit') {
      expect(responsePayloads.size).toBe(panes.length)
      for (const result of windowResults) {
        if (!result || typeof result !== 'object' || !('coldRestore' in result)) {
          throw new Error('missing joined payload')
        }
        expect(payloads).toContain(result.coldRestore)
      }
    }
    console.info(
      JSON.stringify({
        size,
        dimension,
        outcome,
        joinComparisons,
        exitWork,
        retained,
        mapRoots: mapRoots(),
        callerPayloads: responsePayloads.size,
        preparations: preparation.mock.calls.length,
        commits: commits.mock.calls.length,
        processCalls: provider.mock.calls.filter(([opts]) => !opts.attachOnly).length,
        providerCalls: provider.mock.calls.length
      })
    )
    return { counts, retained }
  }

  it.each(['tabs', 'layout', 'callers', 'panes'] as const)(
    'N/10N %s visits and exact outcome roots',
    async (dimension) => {
      for (const size of [N, 10 * N]) {
        await run(size, dimension, dimension === 'layout' ? 'exit' : 'success')
      }
    }
  )
  it.each(['tabs', 'callers'] as const)(
    'exited N/10N %s keeps O(R*(T+L)) consumer work',
    async (dimension) => {
      for (const size of [N, 10 * N]) {
        await run(size, dimension, 'exit')
      }
    }
  )
  it('N/10N absent fallback visits every saved layout node and refuses retired output', async () => {
    for (const size of [N, 10 * N]) {
      await run(size, 'layout', 'absent')
    }
  })
  it('N/10N absent saved tabs visit the full population before refusing retired output', async () => {
    for (const size of [N, 10 * N]) {
      await run(size, 'tabs', 'absent')
    }
  })
  it.each(['cancelled', 'refused', 'successor'] as const)(
    '%s settles every consumer and releases exact roots',
    async (outcome) => {
      await run(N, 'callers', outcome)
    }
  )
})
