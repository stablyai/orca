import { beforeEach, expect, it, vi } from 'vitest'
const { handlers, remote, local } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => unknown>(),
  remote: vi.fn(),
  local: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/desktop-profile' },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, args?: unknown) => unknown) =>
      handlers.set(name, handler),
    removeHandler: vi.fn()
  }
}))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: remote }))
vi.mock('./ephemeral-vm-host', () => ({
  createEphemeralVmHost: () => ({
    listRecipes: local,
    listRecipeCatalog: local,
    doctor: local,
    provision: local,
    cancelProvision: local,
    listRuntimes: vi.fn(() => []),
    attachWorkspace: local,
    cleanup: local,
    stopCleanup: local,
    suspendWorkspace: local,
    resumeWorkspace: local,
    getCleanupCommand: local,
    onProvisionEvent: () => () => {}
  })
}))
import { registerEphemeralVmHandlers } from './ephemeral-vm'
beforeEach(() => {
  vi.clearAllMocks()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked host factory never reads its store argument.
  registerEphemeralVmHandlers({} as never)
})
it('runs server-owned provisioning through that server with no desktop execution', async () => {
  remote.mockResolvedValue({ ok: true, result: { ok: true, runtimeId: 'vm-1' } })
  const args = {
    ownerEnvironmentId: 'central',
    repoId: 'source',
    recipeId: 'vm',
    provisionId: 'one'
  }
  await expect(handlers.get('ephemeralVm:provision')?.(null, args)).resolves.toEqual({
    ok: true,
    runtimeId: 'vm-1'
  })
  expect(remote).toHaveBeenCalledWith(
    '/desktop-profile',
    'central',
    'ephemeralVm.provision',
    { repoId: 'source', recipeId: 'vm', provisionId: 'one' },
    30 * 60_000
  )
  expect(local).not.toHaveBeenCalled()
})
it('fails clearly when the selected server lacks the method without a desktop fallback', async () => {
  remote.mockResolvedValue({ ok: false, error: { message: 'method_not_found' } })
  await expect(
    handlers.get('ephemeralVm:listRecipes')?.(null, {
      repoId: 'source',
      ownerEnvironmentId: 'older-server'
    })
  ).rejects.toThrow('Server-owned VM recipes: method_not_found')
  expect(local).not.toHaveBeenCalled()
})
it('keeps lifecycle actions on their explicit owner and preserves local calls', async () => {
  remote.mockResolvedValue({ ok: true, result: null })
  await handlers.get('ephemeralVm:resumeWorkspace')?.(null, {
    workspaceId: 'workspace',
    ownerEnvironmentId: 'central'
  })
  expect(remote).toHaveBeenCalledWith(
    '/desktop-profile',
    'central',
    'ephemeralVm.resumeWorkspace',
    { workspaceId: 'workspace' },
    60_000
  )
  local.mockResolvedValue({ cancelled: true })
  await handlers.get('ephemeralVm:cancelProvision')?.(null, { provisionId: 'local-request' })
  expect(local).toHaveBeenCalledWith({ provisionId: 'local-request' })
})
