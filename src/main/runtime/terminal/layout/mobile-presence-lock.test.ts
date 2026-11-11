import { mobilePresenceStore as store } from '../../orca-runtime-test-mocks/mobile-presence-store'
import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import * as inputAdmission from '../input/terminal-input-admission'
import './mobile-subscribe-integration.spec'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as GitUsernameModule from '../../../git/git-username'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    listWorktreesStrict: vi.fn().mockResolvedValue([])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})
vi.mock('../../../workspace-hooks/hooks', () => ({
  getEffectiveHooks: vi.fn().mockReturnValue(null),
  runHook: vi.fn().mockResolvedValue({ success: true, output: '' })
}))
vi.mock('../../../workspace-hooks/worktree-runner-script', () => ({
  createSetupRunnerScript: vi.fn()
}))
vi.mock('../../../ipc/worktree-logic', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, computeWorktreePath: vi.fn(), ensurePathWithinWorkspace: vi.fn() }
})
vi.mock('../../../ipc/worktrees/removal/registered-worktree-roots-cache', () => ({
  invalidateAuthorizedRootsCache: vi.fn(),
  invalidateAuthorizedRootsCacheForRepo: vi.fn()
}))
const repoBranchConflictMock = vi.hoisted(() => vi.fn().mockResolvedValue(null))
vi.mock('../../../git/repo', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getDefaultBaseRef: vi.fn().mockReturnValue('origin/main'),
    getBranchConflictKind: repoBranchConflictMock
  }
})

vi.mock('../../../git/git-username', async () => {
  const actual = await vi.importActual<typeof GitUsernameModule>('../../../git/git-username')
  return { ...actual, resolveLocalGitUsername: vi.fn(async () => '') }
})

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

  it('finishes an admitted preview paste then pauses the next action after phone takeover', async () => {
    const { runtime, controller, writes } = createRuntime()
    const admission = vi.spyOn(inputAdmission, 'createTerminalInputReservation')
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
      await expect(result).resolves.toBe(true)
      expect(writes).toHaveLength(2)
      expect(writes.join('')).toBe('x'.repeat(32 * 1024))
      expect(await runtime.writeTerminalPreviewInput('pty-1', 'next')).toBe(false)
      expect(admission).toHaveBeenCalledWith(runtime, 'desktop', undefined)
      expect(writes).toHaveLength(2)
    } finally {
      admission.mockRestore()
      floorClaim.current?.rollback()
    }
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
})

describe('mobile presence lock — multi-mobile semantics', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

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
})

vi.mock('../../../git/repo-branch-conflict', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBranchConflictKind: repoBranchConflictMock
}))
