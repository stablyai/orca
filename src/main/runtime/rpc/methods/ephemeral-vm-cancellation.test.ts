import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ path: '' }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => state.path })
}))
import { EPHEMERAL_VM_METHODS } from './ephemeral-vm'
import { eraseRpcMethods } from '../core'
import { registerEphemeralVmHost } from '../../ephemeral-vm-host-registry'
afterEach(() => {
  registerEphemeralVmHost(null)
  if (state.path) {
    rmSync(state.path, { recursive: true, force: true })
  }
  state.path = ''
})
it.each(['succeeded', 'failed'])(
  'honors explicit cancellation during adoption, with cleanup %s',
  async (cleanupStatus) => {
    state.path = mkdtempSync(join(tmpdir(), 'orca-cancel-review-'))
    const result = {
      ok: true,
      connectionType: 'ssh',
      sshTargetId: 'runtime-ssh-one',
      stderr: '',
      warnings: [],
      runtime: {
        id: 'one',
        recipeResult: {
          schemaVersion: 2,
          connection: {
            type: 'ssh',
            projectRoot: '/workspace/repo',
            target: { host: '10.77.0.2', port: 22, username: 'agent' }
          }
        }
      }
    }
    const provision = vi.fn().mockResolvedValue(result)
    let finish: () => void = () => {}
    const adoptProvisionedRoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const cleanup = vi.fn().mockResolvedValue({ cleanupStatus })
    const cancelProvision = vi.fn().mockResolvedValue({ cancelled: false })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    registerEphemeralVmHost({ provision, adoptProvisionedRoot, cleanup, cancelProvision } as never)
    const methods = eraseRpcMethods(EPHEMERAL_VM_METHODS)
    const method = methods.find((m) => m.name === 'ephemeralVm.provisionWorkspace')!
    const cancel = methods.find((m) => m.name === 'ephemeralVm.cancelProvision')!
    const args = method.params!.parse({
      repoId: 'source',
      recipeId: 'vm',
      provisionId: 'cancel-once',
      workspaceName: 'task',
      projectId: 'project',
      workspaceRequest: { repo: 'source', name: 'task' }
    })
    const runtime = {
      setupProjectExistingFolder: vi.fn().mockResolvedValue({
        setup: { id: 'worker-setup' },
        repo: { id: 'worker-repo', path: '/workspace/repo' }
      }),
      invalidateWorktreeCatalog: vi.fn(),
      deleteProjectHostSetup: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    const pending = method.handler(args, { runtime } as never, vi.fn())
    await vi.waitFor(() => expect(adoptProvisionedRoot).toHaveBeenCalledOnce())
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
      cancel.handler({ provisionId: 'cancel-once' }, {} as never, vi.fn())
    ).resolves.toEqual({ cancelled: true })
    finish()
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('aborted')
    })
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'one' })
    expect(runtime.deleteProjectHostSetup).toHaveBeenCalledTimes(
      cleanupStatus === 'succeeded' ? 1 : 0
    )
    expect(runtime.invalidateWorktreeCatalog).not.toHaveBeenCalled()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the isolated fixture supplies the methods exercised by this ownership test.
    await expect(method.handler(args, { runtime } as never, vi.fn())).resolves.toMatchObject({
      ok: false
    })
    expect(provision).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  }
)
