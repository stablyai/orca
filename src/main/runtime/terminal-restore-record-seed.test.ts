import { describe, expect, it, vi, afterEach } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst } from './bind-first-pane.test-fixture'
import type {
  RuntimePtyTabCloseAuthority,
  HeadlessSeedMetadata,
  RuntimeTerminalBufferSnapshot
} from './runtime-terminal-state-records'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-session-contracts'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'

// STA repro (post-restart blind orchestrator incident): after an app relaunch
// the daemon survives and spawn reattaches silently, but the restore payload
// (snapshot/scrollback/replay + lastTitle) arrives as an RPC result, never as
// an onPtyData event. The runtime's terminal records therefore stayed empty:
// `terminal list` showed connected terminals with no title/preview/lastOutputAt
// and `terminal read` returned a zero-line tail for a running session.
// seedTerminalRestoreTail must fill preview/tail/title from the payload —
// WITHOUT fabricating recency (lastOutputAt) or emitting side-effect facts.

const WORKTREE_ID = 'repo-1::/tmp/probe-worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = `${WORKTREE_ID}@@session-restore`

function makeStore() {
  const session: WorkspaceSessionState = getDefaultWorkspaceSession()
  return {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/probe-worktree',
        displayName: 'probe',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  }
}

function makeRuntimeWithLeaf(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'never' })),
    write: () => true,
    kill: () => true,
    listProcesses: vi.fn(async () => [{ id: PTY_ID, cwd: '/tmp/probe-worktree' }])
  } as never)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: '',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: PTY_ID,
        paneTitle: null,
        title: ''
      }
    ]
  })
  return runtime
}

type RuntimeRecordInternals = {
  ptysById: Map<
    string,
    {
      preview: string
      lastOutputAt: number | null
      waitBlockedAt: number | null
      lastOscTitle: string | null
      tailBuffer: string[]
    }
  >
  ptyTitleTrackersByPtyId: Map<string, { pendingFacts: unknown[] }>
}

describe('seedTerminalRestoreTail', () => {
  it('seeds preview/tail/title from a restore payload without fabricating recency', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: '\x1b]0;osc-title-noise\x07\x1b[32m$ npm test\x1b[0m\r\n\x1b[1mall 42 tests passed\x1b[0m\r\nspinner frame 1\rspinner frame 2\r\n',
      lastTitle: 'restored-agent-title'
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals).toHaveLength(1)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('$ npm test')
    expect(terminal.preview).toContain('all 42 tests passed')
    // CR redraws collapse to the surviving frame, exactly like live bytes.
    expect(terminal.preview).toContain('spinner frame 2')
    expect(terminal.preview).not.toContain('spinner frame 1')
    expect(terminal.preview).not.toContain('\x1b')
    expect(terminal.title).toBe('restored-agent-title')
    // Seeded scrollback is historical — recency must come only from live bytes.
    expect(terminal.lastOutputAt).toBeNull()

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['$ npm test', 'all 42 tests passed', 'spinner frame 2'])

    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(PTY_ID)!
    expect(pty.preview).toContain('all 42 tests passed')
    expect(pty.lastOutputAt).toBeNull()
    expect(pty.waitBlockedAt).toBeNull()
    expect(pty.lastOscTitle).toBe('restored-agent-title')
    // Seed semantics: state writes only — no side-effect facts to deliver.
    expect(internals.ptyTitleTrackersByPtyId.get(PTY_ID)?.pendingFacts ?? []).toEqual([])
  })

  it('lets live bytes land on top of the seed and refuses to re-apply history', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    runtime.onPtyData(PTY_ID, 'live line\r\n', 1234567)

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('restored line')
    expect(terminal.preview).toContain('live line')
    expect(terminal.lastOutputAt).toBe(1234567)

    // A remount reattach delivering the same payload again must be a no-op.
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'restored line\r\n' })
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['restored line', 'live line'])
  })

  it('does not seed records that already saw live output', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.onPtyData(PTY_ID, 'live first\r\n', 42)
    runtime.seedTerminalRestoreTail(PTY_ID, { text: 'stale history\r\n' })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]!.preview).toBe('live first')
    expect(terminals[0]!.lastOutputAt).toBe(42)
  })

  it('keeps a live-tracked title over the payload title', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.onPtyData(PTY_ID, '\x1b]0;live-title\x07', 42)
    runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: 'stale-persisted-title' })

    const internals = runtime as unknown as RuntimeRecordInternals
    expect(internals.ptysById.get(PTY_ID)!.lastOscTitle).toBe('live-title')
  })

  it('seeds title-only payloads (no restore text)', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: 'title-only-restore' })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    expect(terminals[0]!.title).toBe('title-only-restore')
    expect(terminals[0]!.preview).toBe('')
    expect(terminals[0]!.lastOutputAt).toBeNull()
  })

  // A runtime adopting a surviving session may already have published its tab as "Terminal N".
  it('republishes session tabs when a seeded title lands', () => {
    const runtime = makeRuntimeWithLeaf()
    const touch = vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService defines this protected method; the spy only observes it.
      runtime as unknown as { touchMobileSessionSnapshotsForPty: (ptyId: string) => void },
      'touchMobileSessionSnapshotsForPty'
    )

    runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: 'restored-agent-title' })

    expect(touch).toHaveBeenCalledWith(PTY_ID)
  })

  it('caps the parsed suffix of an oversized payload at a line boundary', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: `${'x'.repeat(300 * 1024)}\r\npartial-first-line\r\nfinal restored line\r\n`
    })

    const { terminals } = await runtime.listTerminals(`id:${WORKTREE_ID}`)
    const terminal = terminals[0]!
    expect(terminal.preview).toContain('final restored line')
    // The truncated head (which can start mid-escape) is dropped whole.
    expect(terminal.preview).not.toContain('x')
    const read = await runtime.readTerminal(terminal.handle)
    expect(read.truncated).toBe(true)
    expect(read.tail).toEqual(['partial-first-line', 'final restored line'])
  })

  it('does not stamp waitBlockedAt from a blocked prompt that exists only in seeded history', async () => {
    const runtime = makeRuntimeWithLeaf()

    runtime.seedTerminalRestoreTail(PTY_ID, {
      text: 'Do you trust this workspace?\r\nPress t to trust\r\n'
    })
    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(PTY_ID)!
    expect(pty.waitBlockedAt).toBeNull()

    // A benign heartbeat must not resurrect the historical prompt as blocked NOW.
    runtime.onPtyData(PTY_ID, 'heartbeat ok\r\n', 1_000_000)
    expect(pty.waitBlockedAt).toBeNull()

    // A prompt arriving in genuinely new output still stamps.
    runtime.onPtyData(PTY_ID, 'Do you trust this workspace?\r\nPress t to trust\r\n', 2_000_000)
    expect(pty.waitBlockedAt).toBe(2_000_000)
  })

  it('seeds the pty record for a daemon-scoped id with no synced leaf', async () => {
    const runtime = makeRuntimeWithLeaf()
    const orphanPtyId = `${WORKTREE_ID}@@session-orphan`

    runtime.seedTerminalRestoreTail(orphanPtyId, { text: 'orphan restored\r\n' })

    const internals = runtime as unknown as RuntimeRecordInternals
    const pty = internals.ptysById.get(orphanPtyId)!
    expect(pty.preview).toBe('orphan restored')
    expect(pty.lastOutputAt).toBeNull()
  })
})

describe('terminal query dispatch characterization', () => {
  class QueryDispatchRuntime extends OrcaRuntimeService {
    prepareMobileCreate() {
      this.registerPty('pty-query', 'workspace')
      const pty = this.ptysById.get('pty-query')
      if (!pty) {
        throw new Error('missing_test_pty')
      }
      pty.tabId = 'tab'
      pty.paneKey = makePaneKey('tab', '00000000-0000-4000-8000-000000000001')
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main's layout is the only answer to which pane holds the terminal; it needs a session.
        Reflect.set(this, 'store', {})
        bindPaneFirst(this, {
          worktreeId: 'workspace',
          tabId: 'tab',
          leafId: '00000000-0000-4000-8000-000000000001',
          ptyId: 'pty-query'
        })
      }
      this.pendingMobileTerminalCreatesByKey.set('workspace::tab', {
        activate: false,
        paired: false,
        selectIfNoActiveTab: false
      })
      return pty
    }

    ensureSurface() {
      return this.ensurePtyBackedMobileSurfaceForRendererTab('workspace', 'tab')
    }

    resolveAuthority(authority: RuntimePtyTabCloseAuthority) {
      return this.resolvePtyTabCloseSurfaceAuthority(authority)
    }
  }

  afterEach(() => vi.restoreAllMocks())

  describe('terminal query dispatch', () => {
    it('preserves the two arguments in both protected mobile surface lookups', () => {
      const runtime = new QueryDispatchRuntime(null)
      const pty = runtime.prepareMobileCreate()
      const find = vi.fn(function (this: typeof runtime) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(2)
        return null
      })
      Object.defineProperty(runtime, 'findMobileTerminalSurface', { value: find })
      Object.defineProperty(runtime, 'findLiveRegisteredPtyForRendererTab', { value: () => pty })
      Object.defineProperty(runtime, 'publishPtyBackedMobileSessionTerminal', { value: () => {} })

      try {
        expect(runtime.ensureSurface()).toBeNull()
        expect(find).toHaveBeenCalledTimes(2)
        expect(pty.runtimeSessionOwned).toBe(true)
      } finally {
        runtime.onPtyExit('pty-query', 0)
      }
    })

    it('captures the protected live PTY lookup before reading authority.handle', () => {
      const runtime = new QueryDispatchRuntime(null)
      const original = vi.fn(function (this: typeof runtime) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(1)
        return null
      })
      const replacement = vi.fn(() => null)
      Object.defineProperty(runtime, 'getLivePtyForHandle', {
        configurable: true,
        get: () => original
      })
      const authority: RuntimePtyTabCloseAuthority = {
        get handle() {
          Object.defineProperty(runtime, 'getLivePtyForHandle', { value: replacement })
          return 'handle'
        },
        ptyId: 'pty-query',
        incarnationId: null,
        worktreeId: 'workspace'
      }

      expect(runtime.resolveAuthority(authority)).toBeNull()
      expect(original).toHaveBeenCalledExactlyOnceWith('handle')
      expect(replacement).not.toHaveBeenCalled()
    })

    it.each([
      ['seedHeadlessTerminal', 4],
      ['resizeHeadlessTerminal', 3],
      ['trackHeadlessTerminalData', 3]
    ] as const)('captures recovery %s before its argument getters', (method, argc) => {
      const runtime = new QueryDispatchRuntime(null)
      const original = vi.fn(function (this: typeof runtime) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(argc)
      })
      const replacement = vi.fn()
      Object.defineProperty(runtime, 'disposeHeadlessTerminal', { value: () => {} })
      Object.defineProperty(runtime, 'seedHeadlessTerminal', {
        configurable: true,
        value: () => {}
      })
      Object.defineProperty(runtime, 'resizeHeadlessTerminal', {
        configurable: true,
        value: () => {}
      })
      Object.defineProperty(runtime, 'trackHeadlessTerminalData', {
        configurable: true,
        value: () => {}
      })
      Object.defineProperty(runtime, method, { get: () => original })
      const replace = () => Object.defineProperty(runtime, method, { value: replacement })
      let reads = 0
      Object.defineProperty(runtime, 'getTerminalSize', {
        value: () => ({
          get cols() {
            if (method === 'resizeHeadlessTerminal') {
              replace()
            }
            return 100
          },
          rows: 40
        })
      })

      runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
        'pty-query',
        {
          get data() {
            if (++reads === 2 && method === 'seedHeadlessTerminal') {
              replace()
            }
            return 'snapshot'
          },
          cols: 80,
          rows: 24
        },
        [
          {
            get data() {
              if (method === 'trackHeadlessTerminalData') {
                replace()
              }
              return 'tail'
            },
            seq: 7
          }
        ]
      )

      expect(original).toHaveBeenCalledOnce()
      expect(replacement).not.toHaveBeenCalled()
    })

    it.each(['resizeHeadlessTerminal', 'trackHeadlessTerminalData'] as const)(
      'preserves invoke-time Root lookup for recovery %s',
      (method) => {
        const runtime = new QueryDispatchRuntime(null)
        const original = vi.fn()
        const replacement = vi.fn(function (this: typeof runtime) {
          expect(this).toBe(runtime)
          expect(arguments.length).toBe(3)
        })
        Object.defineProperty(runtime, method, { configurable: true, value: original })
        const argument = {
          get value() {
            Object.defineProperty(runtime, method, { value: replacement })
            return 'pty-query'
          }
        }

        Object.defineProperty(runtime, 'disposeHeadlessTerminal', { value: () => {} })
        Object.defineProperty(runtime, 'seedHeadlessTerminal', { value: () => {} })
        Object.defineProperty(runtime, 'getTerminalSize', {
          value: () => (method === 'resizeHeadlessTerminal' ? { cols: 80, rows: 24 } : null)
        })
        runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
          argument.value,
          { data: 'snapshot', cols: 80, rows: 24 },
          method === 'trackHeadlessTerminalData' ? [{ data: 'tail', seq: 7 }] : []
        )

        expect(original).not.toHaveBeenCalled()
        expect(replacement).toHaveBeenCalledOnce()
        expect(replacement).toHaveBeenCalledWith(
          'pty-query',
          method === 'resizeHeadlessTerminal' ? 80 : 'tail',
          method === 'resizeHeadlessTerminal' ? 24 : 7
        )
      }
    )
  })
})

describe('terminal query reentry characterization', () => {
  class QueryRuntime extends OrcaRuntimeService {
    readonly calls: string[] = []
    surfaceReads = 0

    override getRendererTerminalSerializerGeneration(ptyId: string): number {
      this.calls.push(`generation:${ptyId}`)
      return 27
    }

    override getTerminalSize(ptyId: string): { cols: number; rows: number } {
      this.calls.push(`grid:${ptyId}`)
      return { cols: 100, rows: 40 }
    }

    protected override disposeHeadlessTerminal(ptyId: string): void {
      this.calls.push(`dispose:${ptyId}`)
    }

    override seedHeadlessTerminal(
      ptyId: string,
      data: string,
      size?: { cols: number; rows: number },
      metadata: HeadlessSeedMetadata = {}
    ): void {
      this.calls.push(`seed:${ptyId}:${data}:${size?.cols}:${metadata.cwd}`)
    }

    protected override resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void {
      this.calls.push(`resize:${ptyId}:${cols}:${rows}`)
    }

    protected override trackHeadlessTerminalData(ptyId: string, data: string, seq?: number): void {
      this.calls.push(`data:${ptyId}:${data}:${seq}`)
    }

    protected override findMobileTerminalSurface(
      _worktreeId: string,
      _parentTabId: string,
      _options: { requireReady?: boolean } = {}
    ): RuntimeMobileSessionCreateTerminalResult | null {
      this.surfaceReads += 1
      return null
    }

    ptyHandle(ptyId: string): string {
      this.registerPty(ptyId, 'repo::/tmp/query-workspace')
      const pty = this.ptysById.get(ptyId)
      if (!pty) {
        throw new Error('missing_test_pty')
      }
      return this.issuePtyHandle(pty)
    }

    recoveryState(ptyId: string): { preferred: boolean; hydration: string | undefined } {
      return {
        preferred: this.providerSnapshotPreferredPtys.has(ptyId),
        hydration: this.headlessHydrationState.get(ptyId)
      }
    }

    waitForSurface(signal: AbortSignal): Promise<RuntimeMobileSessionCreateTerminalResult> {
      return this.waitForMobileTerminalSurface('repo::/tmp/query-workspace', 'tab-query', {
        signal
      })
    }

    get pendingGraphChecks(): number {
      return this.graphSyncCallbacks.length
    }
  }

  describe('terminal query runtime re-entry', () => {
    it('uses the public renderer generation override for a handle', () => {
      const runtime = new QueryRuntime(null)
      const handle = runtime.ptyHandle('pty-query')
      expect(runtime.getRendererTerminalSerializerGenerationForHandle(handle)).toBe(27)
      expect(runtime.calls).toEqual(['generation:pty-query'])
      runtime.onPtyExit('pty-query', 0)
    })

    it('recovers through the current runtime overrides in the original output order', () => {
      const runtime = new QueryRuntime(null)
      runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
        'pty-recovery',
        { data: 'snapshot', cols: 80, rows: 24, cwd: '/tmp/query' },
        [{ data: 'tail', seq: 7 }]
      )
      expect(runtime.calls).toEqual([
        'dispose:pty-recovery',
        'seed:pty-recovery:snapshot:80:/tmp/query',
        'grid:pty-recovery',
        'resize:pty-recovery:100:40',
        'data:pty-recovery:tail:7'
      ])
      expect(runtime.recoveryState('pty-recovery')).toEqual({ preferred: true, hydration: 'done' })
      runtime.onPtyExit('pty-recovery', 0)
    })

    it('leaves output ownership untouched when the recovery snapshot is empty', () => {
      const runtime = new QueryRuntime(null)
      runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery('pty-empty', {
        data: '',
        cols: 80,
        rows: 24
      })
      expect(runtime.calls).toEqual([])
      expect(runtime.recoveryState('pty-empty')).toEqual({ preferred: false, hydration: undefined })
    })

    it('uses the protected surface override and removes its graph subscription on abort', async () => {
      const runtime = new QueryRuntime(null)
      const client = new AbortController()
      const waiting = runtime.waitForSurface(client.signal)
      expect(runtime.surfaceReads).toBe(2)
      expect(runtime.pendingGraphChecks).toBe(1)
      client.abort()
      await expect(waiting).rejects.toThrow('client_disconnected')
      expect(runtime.pendingGraphChecks).toBe(0)
    })
  })
})

describe('terminal view promise characterization', () => {
  const snapshot: RuntimeTerminalBufferSnapshot = { data: 'screen', cols: 80, rows: 24 }
  it('returns the current available-state promise with the runtime receiver and original arity', () => {
    const runtime = new OrcaRuntimeService()
    const expected = Promise.resolve(snapshot)
    const receivers: OrcaRuntimeService[] = []
    const arities: number[] = []
    runtime['serializeTerminalBufferFromAvailableState'] = function (
      this: OrcaRuntimeService,
      ...args
    ) {
      receivers.push(this)
      arities.push(args.length)
      expect(args).toEqual(['view-pty', {}])
      return expected
    }
    expect(runtime.serializeTerminalBuffer('view-pty')).toBe(expected)
    expect(receivers).toEqual([runtime])
    expect(arities).toEqual([2])
  })
  it('reads the current fallback after provider completion and keeps provider-first options', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = Promise.withResolvers<PtyProviderBufferSnapshot | null>()
    const receivers: OrcaRuntimeService[] = []
    const opts = { scrollbackRows: 12 }
    runtime['serializeProviderTerminalBuffer'] = function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args).toEqual(['view-pty', opts, { timeoutMs: 8000, retireOnTimeout: true }])
      return provider.promise
    }
    const firstFallback = vi.fn(async () => null)
    runtime['serializeTerminalBufferFromAvailableState'] = firstFallback
    const pending = runtime.serializeAuthoritativeTerminalBuffer('view-pty', opts)
    runtime['serializeTerminalBufferFromAvailableState'] = function (
      this: OrcaRuntimeService,
      ...args
    ) {
      receivers.push(this)
      expect(args).toEqual(['view-pty', opts])
      return Promise.resolve(snapshot)
    }
    provider.resolve(null)
    await expect(pending).resolves.toBe(snapshot)
    expect(firstFallback).not.toHaveBeenCalled()
    expect(receivers).toEqual([runtime, runtime])
  })
  it('skips driver reads for empty input and rechecks the current driver before a write', async () => {
    const runtime = new OrcaRuntimeService()
    const initialDriver = vi.fn(() => ({ kind: 'desktop' as const }))
    runtime.getDriver = initialDriver
    await expect(runtime.writeTerminalPreviewInput('view-pty', '')).resolves.toBe(false)
    expect(initialDriver).not.toHaveBeenCalled()
    const receivers: OrcaRuntimeService[] = []
    runtime['writeTerminalInputChunks'] = async function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args.length).toBe(3)
      expect(args[2].inputKind).toBe('driving')
      runtime.getDriver = function (this: OrcaRuntimeService) {
        receivers.push(this)
        return { kind: 'mobile', clientId: 'phone' }
      }
      await args[2].beforeWrite?.(args[0])
      return undefined
    }
    await expect(runtime.writeTerminalPreviewInput('view-pty', 'paste')).resolves.toBe(false)
    expect(initialDriver).toHaveBeenCalledOnce()
    expect(receivers).toEqual([runtime, runtime])
  })
})
