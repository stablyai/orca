import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { RuntimeMobileSessionTerminalTab } from '../../shared/runtime-types'

describe('terminal rename before renderer graph hydration', () => {
  it.each(['Media Engine Orch', null])(
    'persists and forwards title %s across PTY replacement',
    async (title) => {
      const session = makeWorkspaceSessionWithHeadlessTerminal()
      session.tabsByWorktree[TEST_WORKTREE_ID][0].customTitle = 'Previous name'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
      const checkedStore = runtimeStore as RuntimeStore
      const runtime = new OrcaRuntimeService(checkedStore)
      const renameTerminal = vi.fn()
      runtime.setPtyController({
        spawn: vi.fn(async () => ({ id: 'omp-initial-pty' })),
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
        sleepWorktree: vi.fn(),
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
      runtime.onPtyExit('omp-initial-pty', 0)
      const restored = new OrcaRuntimeService(checkedStore)
      restored.setPtyController({
        spawn: vi.fn(async () => ({ id: 'omp-replacement-pty' })),
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shared fixture implements RuntimeStore; its legacy Mock typing loses callable signatures.
    const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'surviving-pty' })),
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

describe('terminal query constructor characterization', () => {
  const queries = [
    'surface',
    'ptySurface',
    'ensureSurface',
    'waitSurface',
    'mount',
    'generation',
    'handleGeneration',
    'waitGeneration',
    'handle',
    'waitPty',
    'topology',
    'stats',
    'ui',
    'updateUi',
    'feature',
    'emptyRecovery',
    'closeAuthority',
    'summary',
    'read'
  ] as const

  type ConstructorQuery = (typeof queries)[number]

  const refused: Partial<Record<ConstructorQuery, string>> = {
    ui: 'runtime_unavailable',
    updateUi: 'runtime_unavailable',
    feature: 'runtime_unavailable'
  }

  const rejected: Partial<Record<ConstructorQuery, string>> = {
    waitSurface: 'client_disconnected',
    waitPty: 'request_aborted'
  }

  function checkResult(query: ConstructorQuery, value: unknown): void {
    if (query === 'summary') {
      expect(value).toMatchObject({ ptyId: 'ctor-pty', worktreeId: 'missing', orphaned: true })
    } else if (query === 'read') {
      expect(value).toMatchObject({ handle: 'ctor-handle', status: 'unknown', tail: [] })
    } else if (query === 'mount' || query === 'waitGeneration') {
      expect(value).toBe(false)
    } else if (query === 'generation' || query === 'handleGeneration') {
      expect(value).toBe(0)
    } else if (query === 'emptyRecovery') {
      expect(value).toBeUndefined()
    } else {
      expect(value).toBeNull()
    }
  }

  describe('terminal queries during Runtime construction', () => {
    it.each(queries)('preserves %s at the existing cache getter seam', async (query) => {
      let result: unknown
      let error: unknown
      class ConstructorRuntime extends OrcaRuntimeService {
        protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
          try {
            result = this.runQuery(query)
          } catch (caught) {
            error = caught
          }
          return super.canonicalFetchKeyCache
        }

        private runQuery(query: ConstructorQuery): unknown {
          switch (query) {
            case 'surface':
              return this.findMobileTerminalSurface('missing', 'tab')
            case 'ptySurface':
              return this.findMobileTerminalSurfaceForPty('missing', 'pty')
            case 'ensureSurface':
              return this.ensurePtyBackedMobileSurfaceForRendererTab('missing', 'tab')
            case 'waitSurface':
              return this.waitForMobileTerminalSurface('missing', 'tab', {
                signal: AbortSignal.abort()
              })
            case 'mount':
              return this.requestRendererTerminalTabMount('missing')
            case 'generation':
              return this.getRendererTerminalSerializerGeneration('missing')
            case 'handleGeneration':
              return this.getRendererTerminalSerializerGenerationForHandle('missing')
            case 'waitGeneration':
              return this.waitForRendererTerminalSerializer('missing', 0)
            case 'handle':
              return this.resolveHandleForTab('missing')
            case 'waitPty':
              return this.waitForLeafPtyId('missing', 10_000, AbortSignal.abort())
            case 'topology': {
              const topology = this.ptySurfaceTopology()
              expect(topology.graphSequence).toBe(0)
              expect(topology.ptyIdHoldingPane('missing', 'missing')).toBeUndefined()
              return null
            }
            case 'stats':
              return this.getStatsSummary()
            case 'ui':
              return this.getUIState()
            case 'updateUi':
              return this.updateUIState({})
            case 'feature':
              return this.recordFeatureInteraction('browser')
            case 'emptyRecovery':
              return this.replaceHeadlessTerminalFromRendererSnapshotForRecovery('missing', {
                data: '',
                cols: 80,
                rows: 24
              })
            case 'summary':
            case 'read': {
              const pty = this.recordPtyWorktree('ctor-pty', 'missing', {
                connected: false
              })
              return query === 'summary'
                ? this.buildPtyTerminalSummary(pty, new Map())
                : this.readPtyTerminal('ctor-handle', pty)
            }
            case 'closeAuthority':
              return this.resolvePtyTabCloseSurfaceAuthority({
                handle: 'missing',
                ptyId: 'missing',
                incarnationId: null,
                worktreeId: 'missing'
              })
          }
        }
      }
      const runtime = new ConstructorRuntime(null)
      if (query === 'summary' || query === 'read') {
        runtime.onPtyExit('ctor-pty', 0)
      }
      const refusal = refused[query]
      if (refusal) {
        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ message: refusal })
        expect(result).toBeUndefined()
        return
      }
      expect(error).toBeUndefined()
      const rejection = rejected[query]
      if (rejection) {
        expect(result).toBeInstanceOf(Promise)
        await expect(result).rejects.toThrow(rejection)
      } else {
        if (query === 'waitGeneration') {
          expect(result).toBeInstanceOf(Promise)
        }
        checkResult(query, await result)
      }
    })
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
      sleepWorktree() {},
      terminalFitOverrideChanged() {},
      terminalDriverChanged() {}
    }
  }
  it('keeps rename persistence before the current notifier with its own receiver', async () => {
    const runtime = new OrcaRuntimeService()
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
      expect(pty.title).toBe('Pinned')
      expect(pty.titleUpdatedAt).toBeGreaterThan(0)
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

describe('terminal view at the Runtime constructor getter seam', () => {
  const cases = [
    ['headless-state', 'sync', false],
    ['preview-input', 'promise', false],
    ['available-buffer', 'promise', null],
    ['authoritative-buffer', 'promise', null]
  ] as const
  type Query = (typeof cases)[number][0] | 'rename'
  type Observation =
    | { kind: 'sync'; value: unknown }
    | { kind: 'promise'; value: unknown }
    | { kind: 'rejected'; error: unknown }
    | { kind: 'thrown'; error: unknown }

  class ViewConstructionRuntime extends OrcaRuntimeService {
    queryAtConstruction(query: Query): unknown {
      switch (query) {
        case 'headless-state':
          return this.hasHeadlessTerminalState('missing')
        case 'preview-input':
          return this.writeTerminalPreviewInput('missing', '')
        case 'available-buffer':
          return this.serializeTerminalBuffer('missing')
        case 'authoritative-buffer':
          return this.serializeAuthoritativeTerminalBuffer('missing')
        case 'rename':
          return this.renameTerminal('missing', 'title')
      }
    }
  }

  function readDuringConstruction(query: Query): Promise<Observation> {
    let observation: Observation | undefined
    let pending: Promise<Observation> | undefined
    let reads = 0
    class ConstructionProbe extends ViewConstructionRuntime {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        reads += 1
        try {
          const value = this.queryAtConstruction(query)
          if (value instanceof Promise) {
            pending = value.then(
              (resolved) => ({ kind: 'promise', value: resolved }),
              (error: unknown) => ({ kind: 'rejected', error })
            )
          } else {
            observation = { kind: 'sync', value }
          }
        } catch (error) {
          observation = { kind: 'thrown', error }
        }
        return super.canonicalFetchKeyCache
      }
    }
    new ConstructionProbe(null)
    expect(reads).toBe(1)
    if (pending) {
      return pending
    }
    if (!observation) {
      throw new Error('Constructor seam did not produce an observation')
    }
    return Promise.resolve(observation)
  }

  it.each(cases)('keeps %s available before derived initialization', async (query, kind, value) => {
    expect(await readDuringConstruction(query)).toEqual({ kind, value })
  })

  it('keeps rename refusal asynchronous before derived initialization', async () => {
    const observation = await readDuringConstruction('rename')
    expect(observation.kind).toBe('rejected')
    if (observation.kind === 'rejected') {
      expect(observation.error).toBeInstanceOf(Error)
      expect(observation.error).toMatchObject({ message: 'runtime_unavailable' })
    }
  })
})

describe('terminal query erased boundary regressions', () => {
  it('keeps the cached-null pane failure when a later binding read is valid', () => {
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
        expect(() => this.buildPtyTerminalSummary(pty, new Map())).toThrow(TypeError)
        expect(reads).toBeGreaterThanOrEqual(2)
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

  it('restores non-manual fallback title when clearing manual terminal title', () => {
    const runtime = new OrcaRuntimeService(null)
    const worktreeId = 'wt-1'
    const tabId = 'tab-1'
    runtime['tabs'].set(tabId, {
      tabId,
      worktreeId,
      title: 'Original Title',
      customTitle: null,
      activeLeafId: null,
      layout: null
    })
    runtime['mobileSessionTabsByWorktree'].set(worktreeId, {
      worktree: worktreeId,
      tabs: [
        {
          id: 'mob-tab-1',
          type: 'terminal',
          parentTabId: tabId,
          title: 'Original Title',
          customTitle: null
        } as unknown as RuntimeMobileSessionTerminalTab
      ],
      groups: [],
      generation: 1,
      snapshotVersion: 1,
      publicationEpoch: 'epoch'
    })

    runtime['persistHeadlessTerminalTitle'](worktreeId, tabId, 'Custom Title')
    expect(runtime['tabs'].get(tabId)?.title).toBe('Custom Title')
    expect(runtime['tabs'].get(tabId)?.customTitle).toBe('Custom Title')
    expect(runtime['mobileSessionTabsByWorktree'].get(worktreeId)?.tabs[0].title).toBe('Custom Title')

    runtime['persistHeadlessTerminalTitle'](worktreeId, tabId, null)
    expect(runtime['tabs'].get(tabId)?.customTitle).toBeNull()
    expect(runtime['tabs'].get(tabId)?.title).toBe('Terminal')
    expect(runtime['mobileSessionTabsByWorktree'].get(worktreeId)?.tabs[0].title).toBe('Terminal')
  })
})

