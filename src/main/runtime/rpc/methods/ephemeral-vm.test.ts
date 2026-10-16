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
it('completes and durably replays server provisioning after caller disconnect without rerunning provider', async () => {
  state.path = mkdtempSync(join(tmpdir(), 'orca-disconnect-review-'))
  let finish: (value: unknown) => void = () => {}
  const provision = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  registerEphemeralVmHost({ provision } as never)
  const method = eraseRpcMethods(EPHEMERAL_VM_METHODS).find(
    (m) => m.name === 'ephemeralVm.provision'
  )!
  const args = method.params!.parse({ repoId: 'repo', recipeId: 'vm', provisionId: 'stable-retry' })
  const caller = new AbortController()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  const pending = method.handler(args, { signal: caller.signal } as never, vi.fn())
  await vi.waitFor(() => expect(provision).toHaveBeenCalledOnce())
  caller.abort()
  finish({ ok: true, runtime: { id: 'one-vm' } })
  await expect(pending).resolves.toEqual({ ok: true, runtime: { id: 'one-vm' } })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  await expect(method.handler(args, {} as never, vi.fn())).resolves.toEqual({
    ok: true,
    runtime: { id: 'one-vm' }
  })
  expect(provision).toHaveBeenCalledOnce()
})
it('reports absent server host without silently executing a desktop provider', () => {
  registerEphemeralVmHost(null)
  const method = eraseRpcMethods(EPHEMERAL_VM_METHODS).find(
    (m) => m.name === 'ephemeralVm.listRuntimes'
  )!
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  expect(() => method.handler(undefined, {} as never, vi.fn())).toThrow(
    'ephemeral_vm_host_unavailable'
  )
})

it('finishes SSH checkout registration and adoption after the creating client disconnects', async () => {
  state.path = mkdtempSync(join(tmpdir(), 'orca-create-disconnect-'))
  const result = {
    ok: true,
    connectionType: 'ssh',
    sshTargetId: 'runtime-ssh-one',
    expectedRefHead: 'pinned-head',
    stderr: '',
    warnings: [],
    runtime: {
      id: 'one',
      recipeResult: {
        schemaVersion: 2,
        checkoutMode: 'provisioned-root',
        connection: {
          type: 'ssh',
          checkoutMode: 'provisioned-root',
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
  const cleanup = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  registerEphemeralVmHost({ provision, adoptProvisionedRoot, cleanup } as never)
  const setupProjectExistingFolder = vi.fn().mockResolvedValue({
    setup: { id: 'worker-setup' },
    repo: { id: 'worker-repo', path: '/workspace/repo' }
  })
  const invalidateWorktreeCatalog = vi.fn()
  const method = eraseRpcMethods(EPHEMERAL_VM_METHODS).find(
    (m) => m.name === 'ephemeralVm.provisionWorkspace'
  )!
  const args = method.params!.parse({
    repoId: 'source',
    recipeId: 'vm',
    provisionId: 'create-once',
    workspaceName: 'task',
    projectId: 'project',
    workspaceRequest: { repo: 'source', name: 'task' }
  })
  const caller = new AbortController()
  const context = {
    signal: caller.signal,
    runtime: { setupProjectExistingFolder, invalidateWorktreeCatalog }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  const pending = method.handler(args, context as never, vi.fn())
  await vi.waitFor(() => expect(adoptProvisionedRoot).toHaveBeenCalledOnce())
  caller.abort()
  finish()
  await expect(pending).resolves.toEqual(result)
  expect(setupProjectExistingFolder).toHaveBeenCalledWith({
    projectId: 'project',
    hostId: 'ssh:runtime-ssh-one',
    path: '/workspace/repo',
    setupMethod: 'imported-existing-folder'
  })
  expect(adoptProvisionedRoot).toHaveBeenCalledWith(
    expect.objectContaining({
      repoId: 'worker-repo',
      runtimeId: 'one',
      executionHostId: 'ssh:runtime-ssh-one',
      expectedPath: '/workspace/repo',
      expectedRefHead: 'pinned-head',
      name: 'task'
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this isolated fixture supplies only the methods exercised by the handler.
  await expect(method.handler(args, context as never, vi.fn())).resolves.toEqual(result)
  expect(provision).toHaveBeenCalledOnce()
  expect(setupProjectExistingFolder).toHaveBeenCalledOnce()
  expect(adoptProvisionedRoot).toHaveBeenCalledOnce()
  expect(cleanup).not.toHaveBeenCalled()
})
