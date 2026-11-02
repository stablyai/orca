import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

// The real connectWslMoveHostService runs here; only the host's records and runtime are faked.
const host = vi.hoisted(() => ({
  pendingStop: false,
  connect: vi.fn(async () => {}),
  ensureForRuntimeCall: vi.fn(async () => {}),
  call: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
    ok: true,
    result: { terminals: [], truncated: false }
  }))
}))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: (...args: unknown[]) => host.call(...args)
}))
vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => [{ id: 'wsl:Ubuntu' }]
}))
vi.mock('../../shared/runtime-environment-wsl-host-store', () => ({
  findWslHostDeployment: () =>
    host.pendingStop ? { environmentId: 'wsl:ubuntu', pendingStop: { at: 1 } } : null
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => ({
    recordForEnvironment: () => ({ environmentId: 'wsl:ubuntu', distro: 'Ubuntu' }),
    getStatuses: () => [],
    connect: host.connect,
    ensureForRuntimeCall: host.ensureForRuntimeCall
  })
}))

const store = {
  getWorkspaceSession: () => getDefaultWorkspaceSession(),
  patchWorkspaceSession: vi.fn(),
  listAutomations: () => [],
  updateAutomation: vi.fn()
}

describe("undo's stop of the host's terminals: connecting the host", () => {
  const move = wslMoveCutoverFixture('move-1', 'retained', {}, { repoIds: ['repo-a'] })

  it('connects a host that is not serving, as the user’s act', async () => {
    host.pendingStop = false
    host.connect.mockClear()
    expect(await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)).toBe('stopped')
    expect(host.connect).toHaveBeenCalledTimes(1)
  })

  it('never connects a host whose Remove is pending (E11)', async () => {
    host.pendingStop = true
    host.connect.mockClear()
    host.call.mockClear()
    await createWslMoveUndoPorts(store, '/user-data').stopHostCopies(move)
    expect(host.connect).not.toHaveBeenCalled()
    // It got past the removed-host check, so the skip is the pending Remove's.
    expect(host.call).toHaveBeenCalled()
  })

  // A bring-back is not the user's act: it may reach a running distro, never start a stopped one.
  describe('as an automatic bring-back', () => {
    it('connects only through the no-boot path, and offers a preflight', async () => {
      host.pendingStop = false
      host.connect.mockClear()
      host.ensureForRuntimeCall.mockClear()
      const ports = createWslMoveUndoPorts(store, '/user-data', 'automatic')
      expect(await ports.preflightHostCopies?.(move)).toBe('stopped')
      host.call.mockClear()
      expect(await ports.stopHostCopies(move)).toBe('stopped')
      expect(host.ensureForRuntimeCall).toHaveBeenCalled()
      expect(host.connect).not.toHaveBeenCalled()
      expect(host.call).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'worktree.sleep',
        expect.anything(),
        expect.anything()
      )
    })

    it('reads a stopped distro as unreachable, asking the host nothing', async () => {
      host.pendingStop = false
      host.connect.mockClear()
      host.call.mockClear()
      host.ensureForRuntimeCall.mockRejectedValueOnce(new Error('Ubuntu is stopped'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const ports = createWslMoveUndoPorts(store, '/user-data', 'automatic')
      expect(await ports.preflightHostCopies?.(move)).toBe('unreachable')
      expect(host.connect).not.toHaveBeenCalled()
      expect(host.call).not.toHaveBeenCalled()
    })

    it('refuses a live host terminal instead of sleeping it', async () => {
      host.pendingStop = false
      host.call.mockImplementation(async (..._args: unknown[]) => ({
        ok: true,
        result: { terminals: [{ connected: true, worktreeId: 'repo-a::/home/me/a' }] }
      }))
      const ports = createWslMoveUndoPorts(store, '/user-data', 'automatic')
      expect(await ports.stopHostCopies(move)).toBe('still-running')
      expect(host.call).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'worktree.sleep',
        expect.anything(),
        expect.anything()
      )
    })

    it('offers no preflight to the user undo', () => {
      expect(createWslMoveUndoPorts(store, '/user-data').preflightHostCopies).toBeUndefined()
    })
  })
})
