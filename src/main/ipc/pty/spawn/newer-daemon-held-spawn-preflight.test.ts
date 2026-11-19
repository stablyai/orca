import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonPtyAdapter } from '../../../daemon/providers/adapter/daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from '../../../daemon/providers/routing/daemon-session-owner-resolution'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import type * as RegistryModule from '../provider/registry'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from '../ipc/spawn-types'
import type { PtyRuntimeControllerDeps } from '../runtime/controller-deps'
import type { RuntimePtySpawnArgs } from '../runtime/spawn-state'

const mocks = vi.hoisted(() => {
  const state: { provider?: IPtyProvider; resolveStartupTarget: ReturnType<typeof vi.fn> } = {
    resolveStartupTarget: vi.fn()
  }
  return state
})
vi.mock('../../../daemon/providers/routing/daemon-newer-protocol-hold', () => ({
  isHoldingForNewerProtocolDaemon: () => true
}))
vi.mock('../provider/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof RegistryModule>()),
  getProvider: () => mocks.provider
}))
vi.mock('../host-env/spawn-startup-target', () => ({
  resolvePtySpawnStartupTarget: mocks.resolveStartupTarget
}))

const { heldSpawnRefusal } =
  await import('../../../daemon/providers/routing/daemon-router-newer-daemon-hold')
const { createPtyIpcSpawnState } = await import('../ipc/spawn-state')
const { preparePtyIpcSpawnPreflight } = await import('../ipc/spawn-preflight')
const { createRuntimePtySpawnState } = await import('../runtime/spawn-state')
const { prepareRuntimePtySpawn } = await import('../runtime/spawn-preflight')

const SAVED = 'repo1::/tmp/feature@@d3a0a65b'
const WORKTREE = 'repo1::/tmp/feature'

beforeEach(() => {
  mocks.resolveStartupTarget.mockReset()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no daemon answers for the saved id, so the hold reads only these two.
  const noOwner = {
    hasRoute: () => false,
    resolve: async () => ({ kind: 'absent' })
  } as unknown as DaemonSessionOwnerResolver<DaemonPtyAdapter>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preflight refuses before it calls anything else on the provider.
  mocks.provider = { refuseHeldSpawn: heldSpawnRefusal(() => noOwner) } as unknown as IPtyProvider
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
})
