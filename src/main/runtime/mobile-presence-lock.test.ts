import './mobile-subscribe-integration.spec'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { listWorktrees } from '../git/worktree'
import type * as GitUsernameModule from '../git/git-username'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
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
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
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
    // Legacy restore tests need a finite 5s; production defaults to indefinite hold.
    mobileAutoRestoreFitMs: 5_000
  })
}

// #7588 held-modal cases need per-test indefinite hold without mutating the shared default.
function createRuntime(mobileAutoRestoreFitMs: number | null = 5_000) {
  vi.mocked(listWorktrees).mockResolvedValue([])
  const effectiveStore = {
    ...store,
    getSettings: () => ({ ...store.getSettings(), mobileAutoRestoreFitMs })
  }
  const runtime = new OrcaRuntimeService(effectiveStore)
  const ptySizes = new Map<string, { cols: number; rows: number }>([
    ['pty-1', { cols: 150, rows: 40 }]
  ])
  const resizes: { ptyId: string; cols: number; rows: number }[] = []
  const writes: string[] = []
  const driverEvents: { ptyId: string; driver: { kind: string; clientId?: string } }[] = []
  const fitOverrideEvents: { ptyId: string; mode: string; cols: number; rows: number }[] = []
  let resizeSucceeds = true

  const controller: RuntimePtyController = {
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      if (!resizeSucceeds) {
        return false
      }
      ptySizes.set(ptyId, { cols, rows })
      resizes.push({ ptyId, cols, rows })
      return true
    },
    getSize: (ptyId) => ptySizes.get(ptyId) ?? null
  }
  runtime.setPtyController(controller)
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: (ptyId, mode, cols, rows) => {
      fitOverrideEvents.push({ ptyId, mode, cols, rows })
    },
    terminalDriverChanged: (ptyId, driver) => {
      driverEvents.push({ ptyId, driver: { ...driver } })
    }
  })

  return {
    runtime,
    controller,
    ptySizes,
    resizes,
    writes,
    driverEvents,
    fitOverrideEvents,
    setResizeSucceeds: (next: boolean) => {
      resizeSucceeds = next
    }
  }
}

describe('mobile presence lock — driver state machine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts idle for unknown PTY', () => {
    const { runtime } = createRuntime()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('stops a preview paste when mobile claims the floor between chunks', async () => {
    const { runtime, controller, writes } = createRuntime()
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(writes).toHaveLength(0)

    const floorClaim: { current: ReturnType<OrcaRuntimeService['beginMobileInputFloor']> } = {
      current: null
    }
    const originalWrite = controller.write
    vi.spyOn(controller, 'write').mockImplementationOnce((ptyId, data, inputKind) => {
      const accepted = originalWrite(ptyId, data, inputKind)
      floorClaim.current = runtime.beginMobileInputFloor(ptyId, 'phone-A')
      if (!floorClaim.current) {
        throw new Error('phone floor reservation was refused')
      }
      return accepted
    })

    try {
      const result = runtime.writeTerminalPreviewInput('pty-1', 'x'.repeat(32 * 1024))
      await vi.advanceTimersByTimeAsync(0)

      expect(floorClaim.current).not.toBeNull()
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
      await expect(result).resolves.toBe(false)
      expect(writes).toHaveLength(1)
      expect(Buffer.byteLength(writes[0]!, 'utf8')).toBe(16 * 1024)
    } finally {
      floorClaim.current?.rollback()
    }
  })

  it('handleMobileSubscribe in auto mode transitions idle → mobile{clientId}', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('handleMobileSubscribe in desktop mode is passive — does NOT take floor', async () => {
    const { runtime, driverEvents } = createRuntime()
    runtime.setMobileDisplayMode('pty-1', 'desktop')

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents.find((e) => e.driver.kind === 'mobile')).toBeUndefined()
  })

  it('reclaimTerminalForDesktop transitions mobile → desktop and is idempotent', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1').kind).toBe('mobile')

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
  })

  it('mobileTookFloor after reclaim re-applies phone-fit and flips driver back to mobile', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')
    expect(runtime.getDriver('pty-1').kind).toBe('desktop')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
  })

  it('restores the pre-write driver after overlapping claims from one phone both fail', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    const first = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const second = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    first.rollback()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    second.rollback()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
  })

  it('keeps a successful overlapping claim as the rollback baseline', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    const successful = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const rejected = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    await successful.commit()
    rejected.rollback()

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })
  })

  it('does not let an older phone-fit completion retake a newer writer floor', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    await runtime.reclaimTerminalForDesktop('pty-1')

    let releaseFirstLayout!: () => void
    vi.spyOn(runtime, 'applyMobileDisplayMode').mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirstLayout = () => resolve(true)
        })
    )
    const first = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
    const firstCommit = first.commit()
    await vi.waitFor(() => expect(releaseFirstLayout).toBeTypeOf('function'))

    const second = runtime.beginMobileInputFloor('pty-1', 'phone-B')!
    await second.commit()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })

    releaseFirstLayout()
    await firstCommit
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it.each(['before commit', 'during commit', 'direct phone-fit'] as const)(
    'desktop take-back supersedes mobile input %s',
    async (timing) => {
      const { runtime, driverEvents, ptySizes } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
      await runtime.reclaimTerminalForDesktop('pty-1')

      const claim =
        timing === 'direct phone-fit' ? null : runtime.beginMobileInputFloor('pty-1', 'phone-A')!
      let finishLayout = () => {}
      let committing: Promise<void> | undefined
      if (timing !== 'before commit') {
        vi.spyOn(runtime, 'applyMobileDisplayMode').mockImplementationOnce(
          () =>
            new Promise<boolean>((resolve) => {
              finishLayout = () => resolve(true)
            })
        )
        committing = claim ? claim.commit() : runtime.mobileTookFloor('pty-1', 'phone-A')
      }

      await runtime.reclaimTerminalForDesktop('pty-1')
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
      finishLayout()
      await (committing ?? claim!.commit())

      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
      expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'desktop' })
      expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

      await runtime.beginMobileInputFloor('pty-1', 'phone-A')!.commit()
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    }
  )

  it.each(['commit', 'rollback'] as const)(
    'a superseded mobile input %s preserves a newer phone claim',
    async (settle) => {
      const { runtime, driverEvents } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
      await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 60, rows: 25 })
      await runtime.reclaimTerminalForDesktop('pty-1')
      const stale = runtime.beginMobileInputFloor('pty-1', 'phone-A')!
      await runtime.reclaimTerminalForDesktop('pty-1')
      const fresh = runtime.beginMobileInputFloor('pty-1', 'phone-B')!

      await stale[settle]()
      await fresh.commit()

      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
      expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'mobile', clientId: 'phone-B' })
    }
  )

  it('mobile input without an active subscriber cannot create an orphaned floor lock', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(250)

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it.each(['input', 'legacy'] as const)(
    'a %s phone-fit completion after disconnect cannot recreate the mobile lock',
    async (entry) => {
      const { runtime, driverEvents } = createRuntime()
      await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
      await runtime.reclaimTerminalForDesktop('pty-1')

      let finishLayout!: () => void
      vi.spyOn(runtime, 'applyMobileDisplayMode').mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishLayout = () => resolve(true)
          })
      )
      const committing =
        entry === 'input'
          ? runtime.beginMobileInputFloor('pty-1', 'phone-A')!.commit()
          : runtime.mobileTookFloor('pty-1', 'phone-A')
      runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
      await vi.advanceTimersByTimeAsync(250)
      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })

      finishLayout()
      await committing
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
      expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'idle' })
    }
  )

  it('admits a soft-leaving client to reserve the input floor within the grace window', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    const claim = runtime.beginMobileInputFloor('pty-1', 'phone-A')
    expect(claim).not.toBeNull()
    await claim!.commit()
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.beginMobileInputFloor('pty-1', 'phone-A')).toBeNull()
  })

  it('handleMobileUnsubscribe last leaver flips driver to idle after soft-leave grace', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    // Soft-leave grace prevents keyboard re-subscribe cycles from flashing the desktop banner.
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'idle' })
  })

  it('resubscribe within soft-leave grace cancels idle without driver flap', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(500)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.find((e) => e.driver.kind === 'idle')).toBeUndefined()
  })

  it('onPtyExit clears driver state and emits idle', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    runtime.onPtyExit('pty-1', 0)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    const last = [...driverEvents].toReversed().find((e) => e.ptyId === 'pty-1')
    expect(last?.driver).toEqual({ kind: 'idle' })
  })
})

describe('mobile presence lock — multi-mobile semantics', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('elects one query responder and promotes the survivor on unsubscribe', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(true)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(true)

    await runtime.reclaimTerminalForDesktop('pty-1')
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)
  })

  it('keeps the earliest subscriber authoritative after a soft-leave resubscribe', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')

    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(true)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(false)
  })

  it('excludes an older passive desktop-mode subscriber from reply authority', async () => {
    const { runtime } = createRuntime()
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    await vi.advanceTimersByTimeAsync(10)
    runtime.markMobileActor('pty-1', 'phone-B')
    runtime.setMobileDisplayMode('pty-1', 'auto')
    await runtime.applyMobileDisplayMode('pty-1')

    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-A')).toBe(false)
    expect(runtime.isMobileTerminalQueryReplyAuthority('pty-1', 'phone-B')).toBe(true)
  })

  it('most-recent actor wins active phone-fit dims (B subscribes after A)', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    // Separate subscribe timestamps for deterministic ordering.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('B unsubscribes — A still present, driver re-elects to A', async () => {
    const { runtime, driverEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(driverEvents.at(-1)?.driver).toEqual({ kind: 'mobile', clientId: 'phone-A' })
  })

  it('A then B unsubscribes — peer survives; final unsubscribe goes idle', async () => {
    const { runtime } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')
    // Wait through soft-leave grace before expecting idle.
    await vi.advanceTimersByTimeAsync(250)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('terminal.send by phone-B updates lastActedAt — applyMobileDisplayMode picks B viewport', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    // Separate subscribe timestamps for deterministic ordering.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    // Separate lastActedAt timestamps before transferring the floor.
    await vi.advanceTimersByTimeAsync(10)
    await runtime.mobileTookFloor('pty-1', 'phone-B')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('mobile mode change marks the caller before applying phone-fit', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await vi.advanceTimersByTimeAsync(10)
    runtime.markMobileActor('pty-1', 'phone-B')
    runtime.setMobileDisplayMode('pty-1', 'auto')
    await runtime.applyMobileDisplayMode('pty-1')

    expect(ptySizes.get('pty-1')).toEqual({ cols: 38, rows: 18 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-B' })
  })

  it('updateMobileViewport re-fits PTY without flipping the driver', async () => {
    const { runtime, ptySizes, driverEvents, fitOverrideEvents } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    const before = driverEvents.length
    const fitEventsBefore = fitOverrideEvents.length

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: true })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 16 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    // Viewport updates must never pass through idle and flash a banner.
    expect(driverEvents.slice(before).every((e) => e.driver.kind === 'mobile')).toBe(true)
    // Keyboard viewport churn must not wake fit listeners without a layout-kind/override-presence change.
    expect(fitOverrideEvents.length).toBe(fitEventsBefore)
  })

  it('updateMobileViewport late-binds a viewport-less mobile subscriber', async () => {
    const { runtime, ptySizes } = createRuntime()

    expect(await runtime.handleMobileSubscribe('pty-1', 'phone-A')).toBe(false)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: true })

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 16 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('updateDesktopViewport resizes the source PTY and records desktop geometry', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()

    expect(await runtime.updateDesktopViewport('pty-1', { cols: 132, rows: 44 })).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 44 })
    expect(resizes.at(-1)).toEqual({ ptyId: 'pty-1', cols: 132, rows: 44 })
    // Controller drift must not overwrite remembered renderer geometry.
    ptySizes.set('pty-1', { cols: 160, rows: 50 })
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 44 })
  })

  it('updateMobileViewport records viewport without applying layout in desktop mode', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    runtime.setMobileDisplayMode('pty-1', 'desktop')
    await runtime.applyMobileDisplayMode('pty-1')

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: false })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('updateMobileViewport reports applied=false when phone-fit resize fails', async () => {
    const { runtime, ptySizes, setResizeSucceeds } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    setResizeSucceeds(false)

    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    ).resolves.toEqual({ updated: true, applied: false })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })
  })

  it('updateDesktopViewport records restore geometry while phone-fit override is held', async () => {
    const { runtime, ptySizes, resizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 20 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 20 })
    resizes.length = 0

    expect(await runtime.updateDesktopViewport('pty-1', { cols: 132, rows: 44 })).toBe(true)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 20 })
    expect(resizes).toEqual([])

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 132, rows: 44 })
  })

  it('updateMobileViewport then disconnect restores PTY to original baseline', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })

    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })
    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 38 })
    await runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 49, rows: 16 })

    runtime.onClientDisconnected('phone-A')
    // Disconnect queues work; flush microtasks and zero-delay timers.
    await vi.advanceTimersByTimeAsync(0)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
  })

  it('legacy unsubscribe → resubscribe within grace preserves baseline (regression)', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 38 })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 49, rows: 38 })

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 49, rows: 16 })
    await runtime.applyMobileDisplayMode('pty-1')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(0)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('earliest-subscribe restore target is preserved when peers churn', async () => {
    const { runtime, ptySizes } = createRuntime()
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    await vi.advanceTimersByTimeAsync(10)
    await runtime.handleMobileSubscribe('pty-1', 'phone-B', { cols: 38, rows: 18 })

    // Restore A's original desktop baseline, never B's already phone-fitted baseline.
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    runtime.handleMobileUnsubscribe('pty-1', 'phone-B')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })
})

// #7588: null-viewport re-subscribe leaves an active subscriber under the held fit override.
async function reachHeldModalWithNullViewportResubscribe(
  runtime: OrcaRuntimeService
): Promise<void> {
  await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
  runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
  await vi.advanceTimersByTimeAsync(300)
  await runtime.handleMobileSubscribe('pty-1', 'phone-A', undefined)
}

describe('mobile presence lock — issue #7588 held-modal restore convergence', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reclaim after a null-viewport resubscribe restores dims, clears override, notifies both channels', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 45, rows: 20 })

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  it('second Restore click after success returns true with no new resize or fit-override event', async () => {
    const { runtime, resizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    const resizeCount = resizes.length
    const notifierCount = fitOverrideEvents.length
    const listenerCount = listenerEvents.length

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(resizes.length).toBe(resizeCount)
    expect(fitOverrideEvents.length).toBe(notifierCount)
    expect(listenerEvents.length).toBe(listenerCount)
  })

  it('driving take-back still converges: driver → desktop, override cleared, both channels notified', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime()
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1').kind).toBe('mobile')
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(fitOverrideEvents.some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Explicit take-back releases even on resize failure; automatic restore still keeps the lock (#7588).
  it('held restore with a failing resize still releases and clears the override', async () => {
    const { runtime, fitOverrideEvents, setResizeSucceeds } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(300)
    expect(runtime.isMobileSubscriberActive('pty-1')).toBe(false)
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    setResizeSucceeds(false)

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  it('active-subscriber take-back with a failing resize still releases the lock', async () => {
    const { runtime, fitOverrideEvents, setResizeSucceeds } = createRuntime()
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 45, rows: 20 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length
    setResizeSucceeds(false)

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(runtime.getMobileDisplayMode('pty-1')).toBe('desktop')
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  it('phone-initiated setDisplayMode(desktop) against a stale held override converges', async () => {
    const { runtime, ptySizes, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    await reachHeldModalWithNullViewportResubscribe(runtime)
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const notifierBefore = fitOverrideEvents.length
    const listenerBefore = listenerEvents.length

    runtime.setMobileDisplayMode('pty-1', 'desktop')
    const converged = await runtime.applyMobileDisplayMode('pty-1')

    expect(converged).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(fitOverrideEvents.slice(notifierBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
    expect(listenerEvents.slice(listenerBefore).some((e) => e.mode === 'desktop-fit')).toBe(true)
  })

  // Public PTY exit clears both maps; seed the otherwise unreachable orphan for cleanup coverage.
  it('orphan cleanup: reclaim on a held override with no layout entry converges', async () => {
    const { runtime, fitOverrideEvents } = createRuntime(null)
    const listenerEvents: { mode: string; cols: number; rows: number }[] = []
    runtime.subscribeToFitOverrideChanges('pty-1', (e) => listenerEvents.push(e))

    const internal = runtime as unknown as {
      terminalFitOverrides: Map<
        string,
        {
          mode: string
          cols: number
          rows: number
          previousCols: number | null
          previousRows: number | null
          updatedAt: number
          clientId: string
        }
      >
    }
    internal.terminalFitOverrides.set('pty-1', {
      mode: 'mobile-fit',
      cols: 45,
      rows: 20,
      previousCols: 150,
      previousRows: 40,
      updatedAt: Date.now(),
      clientId: 'phone-A'
    })
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    const restored = await runtime.reclaimTerminalForDesktop('pty-1')

    expect(restored).toBe(true)
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(fitOverrideEvents.find((e) => e.mode === 'desktop-fit')).toEqual({
      ptyId: 'pty-1',
      mode: 'desktop-fit',
      cols: 0,
      rows: 0
    })
    expect(listenerEvents.find((e) => e.mode === 'desktop-fit')).toEqual({
      mode: 'desktop-fit',
      cols: 0,
      rows: 0
    })
  })
})

// Passive resume/reconnect viewport reports previously stole the floor back after desktop take-back.
describe('mobile presence lock — desktop take-back survives passive viewport reports', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a still-subscribed phone reporting its viewport does not undo a desktop take-back', async () => {
    const { runtime, ptySizes, driverEvents } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    const driverEventsBefore = driverEvents.length

    await vi.advanceTimersByTimeAsync(10)
    await expect(
      runtime.updateMobileViewport('pty-1', 'phone-A', { cols: 40, rows: 20 })
    ).resolves.toEqual({ updated: true, applied: false })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(driverEvents.slice(driverEventsBefore)).toEqual([])
  })

  it('a deliberate mobile gesture still re-takes the floor after a desktop take-back', async () => {
    const { runtime, ptySizes } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    await vi.advanceTimersByTimeAsync(10)
    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 40, rows: 20 })
  })
})

describe('mobile presence lock — desktop take-back survives automatic resubscribes (#28487)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a replayed subscribe after a reconnect does not undo a desktop take-back', async () => {
    const { runtime, ptySizes, driverEvents } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    const driverEventsBefore = driverEvents.length

    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(1_000)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
    expect(runtime.getTerminalFitOverride('pty-1')).toBeNull()
    expect(
      driverEvents.slice(driverEventsBefore).find((e) => e.driver.kind === 'mobile')
    ).toBeUndefined()
  })

  it('a foreground resubscribe inside the soft-leave grace does not undo a desktop take-back', async () => {
    const { runtime, ptySizes } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)

    runtime.handleMobileUnsubscribe('pty-1', 'phone-A')
    await vi.advanceTimersByTimeAsync(100)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    await vi.advanceTimersByTimeAsync(500)

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })

  it('typing on the phone after a reconnect re-takes the floor and phone-fits again', async () => {
    const { runtime, ptySizes } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(1_000)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'idle' })

    await runtime.mobileTookFloor('pty-1', 'phone-A')

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'mobile', clientId: 'phone-A' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 40, rows: 20 })
    expect(runtime.getMobileDisplayMode('pty-1')).toBe('auto')
  })

  it('take-back of a held phone-fit with no subscriber also keeps the next subscribe passive', async () => {
    const { runtime, ptySizes } = createRuntime(null)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })
    runtime.onClientDisconnected('phone-A')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runtime.getTerminalFitOverride('pty-1')).not.toBeNull()

    expect(await runtime.reclaimTerminalForDesktop('pty-1')).toBe(true)
    await runtime.handleMobileSubscribe('pty-1', 'phone-A', { cols: 40, rows: 20 })

    expect(runtime.getDriver('pty-1')).toEqual({ kind: 'desktop' })
    expect(ptySizes.get('pty-1')).toEqual({ cols: 150, rows: 40 })
  })
})
