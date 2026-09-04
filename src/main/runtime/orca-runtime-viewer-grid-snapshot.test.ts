import { describe, expect, it, vi } from 'vitest'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

vi.mock('../hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../worktree-runner-script', () => ({ createSetupRunnerScript: vi.fn() }))

vi.mock('../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})

vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn()
}))

vi.mock('../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: vi.fn().mockResolvedValue(null)
  }
})

vi.mock('../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

// Why: default the mock store to the clamp floor (5_000ms) so legacy "restore fires after delay" assertions hold; the real default is indefinite/null.
const LEGACY_RESTORE_MS = 5_000
const settingsState = {
  mobileAutoRestoreFitMs: LEGACY_RESTORE_MS as number | null
}

const store = {
  getRepo: () => ({
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }),
  getRepos: () => [store.getRepo()],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    mobileAutoRestoreFitMs: settingsState.mobileAutoRestoreFitMs
  }),
  updateSettings: (updates: { mobileAutoRestoreFitMs?: number | null }) => {
    if ('mobileAutoRestoreFitMs' in updates) {
      settingsState.mobileAutoRestoreFitMs = updates.mobileAutoRestoreFitMs ?? null
    }
  }
}

// A preview card or a phone claims the PTY grid; the desktop pane parks at
// that grid and stops receiving resizes. Its xterm is then the wrong source
// for a viewer's snapshot, and the headless emulator — resized by applyLayout
// — is the only buffer that tracks the PTY.
function createRuntimeWithRendererPane(args: {
  ptySize: { cols: number; rows: number } | null
  rendererFrame: { data: string; cols: number; rows: number; seq?: number } | null
  providerFrame?: {
    data: string
    cols: number
    rows: number
    scrollbackAnsi?: string
    seq?: number
  }
  rendererRegistered?: () => boolean
}) {
  const runtime = new OrcaRuntimeService(store)
  const serializeBuffer = vi.fn(async () =>
    args.rendererFrame ? { seq: 1, ...args.rendererFrame } : null
  )
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: () => true,
    getSize: () => args.ptySize,
    hasRendererSerializer: () => args.rendererRegistered?.() ?? true,
    serializeBuffer,
    serializeProviderBuffer: async () =>
      args.providerFrame ? { seq: 1, source: 'headless', ...args.providerFrame } : null
  } as never)
  return { runtime, serializeBuffer }
}

const internals = (runtime: OrcaRuntimeService) =>
  runtime as unknown as {
    providerSnapshotPreferredPtys: Set<string>
    headlessTerminals: Map<string, { outputSequence: number; emulator: { dispose: () => void } }>
    headlessHydrationState: Map<string, string>
  }

describe('viewer snapshot at the PTY grid', () => {
  it('serves an empty frame at the PTY grid rather than the parked pane default', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: { data: '', cols: 80, rows: 24 }
    })
    runtime.ensureHeadlessTerminalForViewer('pty-1')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22, data: '' })
  })

  // A phone's subscribe never calls ensureHeadlessTerminalForViewer; the
  // serializer itself must build the emulator at the PTY grid.
  it('serves the empty frame at the PTY grid with no viewer-side hydration call', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: { data: '', cols: 80, rows: 24 }
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22, data: '' })
  })

  it('re-lays the pane content out at the PTY grid when the two disagree', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: { data: 'hello from the pane\r\n', cols: 80, rows: 24 }
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22 })
    expect(snapshot?.data).toContain('hello from the pane')
  })

  it('still serves the pane frame when it matches the PTY grid', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 80, rows: 24 },
      rendererFrame: { data: 'prompt %', cols: 80, rows: 24 }
    })

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'renderer', cols: 80, rows: 24, data: 'prompt %' })
    expect(runtime.hasHeadlessTerminalState('pty-1')).toBe(false)
  })

  it("re-lays an adopted session's daemon frame out at the PTY grid too", async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: { data: '', cols: 80, rows: 24 },
      providerFrame: { data: 'restored from the daemon\r\n', cols: 110, rows: 40 }
    })
    // A cold-restored session prefers the daemon's snapshot over anything main has.
    internals(runtime).providerSnapshotPreferredPtys.add('pty-1')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ cols: 85, rows: 22 })
    expect(snapshot?.data).toContain('restored from the daemon')
  })

  it("keeps the daemon frame's scrollback when re-laying it out", async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: null,
      providerFrame: {
        data: 'the prompt\r\n',
        scrollbackAnsi: 'older history line\r\n',
        cols: 110,
        rows: 40
      },
      rendererRegistered: () => false
    })
    internals(runtime).providerSnapshotPreferredPtys.add('pty-1')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22 })
    expect(`${snapshot?.scrollbackAnsi ?? ''}${snapshot?.data}`).toContain('older history line')
    expect(snapshot?.data).toContain('the prompt')
  })

  it('keeps a live emulator whose bytes a lagging daemon frame cannot cover', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: null,
      providerFrame: { data: 'stale daemon frame\r\n', cols: 110, rows: 40 },
      rendererRegistered: () => false
    })
    internals(runtime).providerSnapshotPreferredPtys.add('pty-1')
    runtime.onPtyData('pty-1', 'live bytes main already parsed\r\n', Date.now())
    const live = internals(runtime).headlessTerminals.get('pty-1')
    expect(live).toBeDefined()
    const dispose = vi.spyOn(live!.emulator, 'dispose')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22 })
    expect(snapshot?.data).toContain('live bytes main already parsed')
    expect(dispose).not.toHaveBeenCalled()
    expect(internals(runtime).headlessTerminals.get('pty-1')).toBe(live)
  })
})

describe('reframed snapshot sequence', () => {
  it('carries the source frame seq and replays the bytes published during capture', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: null,
      providerFrame: { data: 'frame at seq 5\r\n', cols: 110, rows: 40, seq: 5 },
      rendererRegistered: () => false
    })
    internals(runtime).providerSnapshotPreferredPtys.add('pty-1')
    // Five chars already counted before the capture: the frame covers them.
    runtime.onPtyData('pty-1', 'abcde', Date.now())
    ;(
      runtime as unknown as { serializeProviderTerminalBuffer: unknown }
    ).serializeProviderTerminalBuffer = async () => {
      // Bytes published while the daemon serializes its frame.
      runtime.onPtyData('pty-1', 'after the frame\r\n', Date.now())
      return { data: 'frame at seq 5\r\n', cols: 110, rows: 40, seq: 5, source: 'headless' }
    }

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot).toMatchObject({ source: 'headless', cols: 85, rows: 22 })
    expect(snapshot?.data).toContain('frame at seq 5')
    expect(snapshot?.data).toContain('after the frame')
    // Monotonic with the bytes actually in the emulator: 5 + the 17 trailing chars.
    expect(snapshot?.seq).toBe(5 + 'after the frame\r\n'.length)
  })

  it('keeps the source seq when the capture cannot prove it is contiguous', async () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: null,
      // The frame stops at seq 2 although main has already counted 5 chars.
      providerFrame: { data: 'older frame\r\n', cols: 110, rows: 40, seq: 2 },
      rendererRegistered: () => false
    })
    internals(runtime).providerSnapshotPreferredPtys.add('pty-1')
    runtime.onPtyData('pty-1', 'abcde', Date.now())
    // Nothing main-side holds (2, 5] any more (an execution-context change dropped it).
    ;(
      runtime as unknown as { disposeHeadlessTerminal: (ptyId: string) => void }
    ).disposeHeadlessTerminal('pty-1')

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })

    expect(snapshot?.data).toContain('older frame')
    // The viewer fills (2, 5] from its own buffer rather than trusting the frame.
    expect(snapshot?.seq).toBe(2)
  })
})

describe('viewer-created emulator', () => {
  it('still hydrates from the renderer once its serializer registers', async () => {
    let registered = false
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: { cols: 85, rows: 22 },
      rendererFrame: { data: 'history the pane holds\r\n', cols: 85, rows: 22 },
      rendererRegistered: () => registered
    })
    runtime.ensureHeadlessTerminalForViewer('pty-1')
    expect(runtime.hasHeadlessTerminalState('pty-1')).toBe(true)
    expect(internals(runtime).headlessHydrationState.get('pty-1')).toBe('awaiting-serializer')

    registered = true
    runtime.onPtyData('pty-1', 'a live byte\r\n', Date.now())

    const snapshot = await runtime.serializeTerminalBuffer('pty-1', { scrollbackRows: 24 })
    expect(snapshot?.data).toContain('history the pane holds')
    expect(snapshot?.data).toContain('a live byte')
    expect(internals(runtime).headlessHydrationState.get('pty-1')).toBe('done')
  })

  it('is not created for a pty the runtime has no grid for', () => {
    const { runtime } = createRuntimeWithRendererPane({
      ptySize: null,
      rendererFrame: null,
      rendererRegistered: () => false
    })

    runtime.ensureHeadlessTerminalForViewer('pty-gone')

    expect(runtime.hasHeadlessTerminalState('pty-gone')).toBe(false)
    expect(internals(runtime).headlessHydrationState.has('pty-gone')).toBe(false)
  })
})
