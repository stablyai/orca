import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

// The real connectWslMoveHostService runs here; only the host's records and runtime are faked.
const host = vi.hoisted(() => ({
  pendingStop: false,
  connect: vi.fn(async () => {}),
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
    ensureForRuntimeCall: vi.fn()
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
})
