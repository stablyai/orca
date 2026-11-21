import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../../../daemon/providers/adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from '../../../daemon/providers/routing/daemon-session-owner-resolution'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type * as RegistryModule from '../provider/registry'
import type * as AbsentPaneOwnerModule from '../pane/absent-pane-owner'
import { SessionNotFoundError } from '../../../daemon/protocol/daemon-errors'
import type { StablePaneSpawnContext } from '../pane/stable-owner'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from '../ipc/spawn-types'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import type { RuntimePtySpawnArgs } from '../runtime/spawn-state'

const mocks = vi.hoisted(() => {
  const state: {
    provider?: IPtyProvider
    resolveStartupTarget: ReturnType<typeof vi.fn>
    releaseAbsentOwner: ReturnType<typeof vi.fn>
  } = { resolveStartupTarget: vi.fn(), releaseAbsentOwner: vi.fn() }
  return state
})
vi.mock('../pane/absent-pane-owner', async (importOriginal) => ({
  ...(await importOriginal<typeof AbsentPaneOwnerModule>()),
  releaseAbsentPaneOwner: mocks.releaseAbsentOwner
}))
vi.mock('../../../daemon/providers/routing/daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: () => true,
  recheckNewerProtocolHold: () => true
}))
vi.mock('../provider/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof RegistryModule>()),
  getProvider: () => mocks.provider
}))
vi.mock('../host-env/spawn-startup-target', () => ({
  resolvePtySpawnStartupTarget: mocks.resolveStartupTarget
}))

const { heldSpawnRefusal, resolveHeldOwner } =
  await import('../../../daemon/providers/routing/daemon-router-newer-daemon-hold')
const { createPtyIpcSpawnState } = await import('../ipc/spawn-state')
const { preparePtyIpcSpawnPreflight } = await import('../ipc/spawn-preflight')
const { createRuntimePtySpawnState } = await import('../runtime/spawn-state')
const { prepareRuntimePtySpawn } = await import('../runtime/spawn-preflight')
const { attemptStablePaneAttach } = await import('../pane/stable-pane-attach')
const { DegradedDaemonOwnerRecovery } =
  await import('../../../daemon/providers/routing/degraded-daemon-owner-recovery')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'
const WORKTREE = 'repo1::/tmp/feature'

beforeEach(() => {
  mocks.resolveStartupTarget.mockReset()
  mocks.releaseAbsentOwner.mockReset()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no daemon answers for the saved id, so the hold reads only these two.
  const noOwner = {
    hasRoute: () => false,
    resolve: async () => ({ kind: 'absent' })
  } as unknown as DaemonSessionOwnerResolver<DaemonPtyAdapter>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight refuses before it calls anything else on the provider.
  mocks.provider = {
    refuseHeldSpawn: heldSpawnRefusal(
      () => false,
      (opts) => resolveHeldOwner(opts.sessionId, noOwner, [])
    )
  } as unknown as IPtyProvider
})

describe('a restored pane while a newer daemon may still run its saved session', () => {
  it('is refused in the renderer lane before main marks or prepares anything under that id', async () => {
    const markHidden = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal happens before preflight reads any other dependency.
    const deps = {
      transitionSpawnHiddenRendererPtyDeliveryState: markHidden,
      assertWorkspaceAcceptsNewPty: () => undefined
    } as unknown as PtySpawnIpcDeps
    const args: PtySpawnIpcArgs = {
      cols: 80,
      rows: 24,
      worktreeId: WORKTREE,
      sessionId: SAVED,
      initiallyHidden: true
    }
    await expect(preparePtyIpcSpawnPreflight(createPtyIpcSpawnState(deps, args))).rejects.toThrow(
      'terminal_held_by_newer_daemon'
    )
    expect(markHidden).not.toHaveBeenCalled()
    expect(mocks.resolveStartupTarget).not.toHaveBeenCalled()
  })

  it('is refused in the runtime lane before main prepares anything under that id', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission is the only dependency read before the refusal.
    const deps = {
      assertWorkspaceAcceptsNewPty: () => undefined
    } as unknown as PtyRuntimeControllerDeps
    const args: RuntimePtySpawnArgs = { cols: 80, rows: 24, worktreeId: WORKTREE, sessionId: SAVED }
    await expect(prepareRuntimePtySpawn(createRuntimePtySpawnState(deps, args))).rejects.toThrow(
      'terminal_held_by_newer_daemon'
    )
    expect(mocks.resolveStartupTarget).not.toHaveBeenCalled()
  })

  it('keeps the pane bound when its stable owner is absent here', async () => {
    const provider = mocks.provider
    if (!provider) {
      throw new Error('provider not set')
    }
    provider.spawn = () => Promise.reject(new SessionNotFoundError(SAVED))
    const owner = {
      tabId: 'tab-1',
      leafId: 'leaf-1',
      ptyId: SAVED,
      hasPersistedBinding: true as const
    }
    const context: StablePaneSpawnContext = {
      runtime: undefined,
      provider,
      spawnOptions: { cols: 80, rows: 24 },
      owner
    }
    await expect(attemptStablePaneAttach({ ...context, owner })).rejects.toThrow(
      'terminal_held_by_newer_daemon'
    )
    expect(mocks.releaseAbsentOwner).not.toHaveBeenCalled()
  })

  it('starts nothing through the degraded fallback either', async () => {
    const spawnFresh = vi.fn()
    const recovery = new DegradedDaemonOwnerRecovery([], [], new Map(), spawnFresh)
    await expect(recovery.spawn({ cols: 80, rows: 24, sessionId: SAVED })).rejects.toThrow(
      'terminal_held_by_newer_daemon'
    )
    expect(spawnFresh).not.toHaveBeenCalled()
  })
})
