import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'

const environments = vi.hoisted(() => ({ ids: ['wsl:ubuntu'] }))
const service = vi.hoisted(() => ({
  ensureForUserRequest: vi.fn(async (_environmentId: string) => {})
}))
const callRuntimeEnvironment = vi.hoisted(() =>
  vi.fn(async (_userDataPath: string, _environmentId: string, method: string) =>
    method === 'terminal.list'
      ? { ok: true, result: { terminals: [] } }
      : { ok: true, result: { slept: true } }
  )
)

vi.mock('../../shared/runtime-environment-store', () => ({
  listEnvironments: () => environments.ids.map((id) => ({ id }))
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({ getWslHostService: () => service }))
vi.mock('./runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-desktop-rewrite', () => ({
  wslMoveDesktopRewriteContext: () => ({})
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-rewrite-scope', () => ({
  wslMoveRewriteScope: () => ({
    inScope: (id: string) => id.startsWith('repo-1::'),
    worktreeId: (id: string) => `host-${id}`
  })
}))

import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

function ports(tabWorkspaceIds: string[]) {
  const store = {
    getWorkspaceSession: () => ({
      tabsByWorktree: Object.fromEntries(tabWorkspaceIds.map((id) => [id, [{ id: 'tab' }]]))
    })
  }
  return createWslMoveUndoPorts(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: undo reads only getWorkspaceSession, which the fake provides.
    store as unknown as Parameters<typeof createWslMoveUndoPorts>[0],
    '/user-data'
  )
}

const move = wslMoveCutoverFixture('move-1', 'retained', { destinationEnvironmentId: 'wsl:ubuntu' })

describe('WSL move undo ports', () => {
  beforeEach(() => {
    environments.ids = ['wsl:ubuntu']
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('connects a host with no open work before stopping its copies, as after a relaunch', async () => {
    await expect(ports(['repo-1::wt']).stopHostCopies(move)).resolves.toBe('stopped')
    expect(service.ensureForUserRequest).toHaveBeenCalledWith('wsl:ubuntu')
    expect(service.ensureForUserRequest.mock.invocationCallOrder[0]).toBeLessThan(
      callRuntimeEnvironment.mock.invocationCallOrder[0]
    )
  })

  it('reports the host unreachable only when that connect fails', async () => {
    service.ensureForUserRequest.mockRejectedValueOnce(new Error('distro failed to start'))
    await expect(ports(['repo-1::wt']).stopHostCopies(move)).resolves.toBe('unreachable')
    expect(callRuntimeEnvironment).not.toHaveBeenCalled()
  })

  it('boots nothing when no terminal of the project ran on the host', async () => {
    await expect(ports(['other::wt']).stopHostCopies(move)).resolves.toBe('stopped')
    expect(service.ensureForUserRequest).not.toHaveBeenCalled()
  })

  it('proceeds without connecting when the user removed the host', async () => {
    environments.ids = []
    await expect(ports(['repo-1::wt']).stopHostCopies(move)).resolves.toBe('stopped')
    expect(service.ensureForUserRequest).not.toHaveBeenCalled()
  })
})
