// The create wizard names its sandbox before it has a workspace: by the create's server
// environment (owned runtime record) or a GitHub-only create's sandbox id.
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('./hosted-sandbox-share-ipc', () => ({
  registerCloudShareHandlers: vi.fn(),
  hostedSandboxIdForEnvironment: (_path: string, environmentId: string) =>
    environmentId === 'env-owned' ? 'sbx_owned' : null
}))
vi.mock('./cloud-workspace-target', () => ({
  findCloudSandbox: (_path: string, args: { workspaceId: string; environmentId?: string }) =>
    args.workspaceId === 'ws-1' || args.environmentId === 'env-paired'
      ? { sandboxId: 'sbx_paired', owned: null }
      : null
}))
vi.mock('./hosted-workspace-runtime', () => ({ NOT_CLOUD: {}, failure: () => ({}) }))
vi.mock('./hosted-sandbox-control-plane-client', () => ({ createHostedSandboxRequest: vi.fn() }))

import { resolveGitAccessSandbox } from './hosted-git-access-ipc'

it('resolves a sandbox by id, owned or paired environment, or workspace', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver validates untrusted IPC input of any shape.
  const resolve = (args: unknown) => resolveGitAccessSandbox('/tmp/u', args as never)
  expect(resolve({ sandboxId: 'sbx_gh' })).toBe('sbx_gh')
  expect(resolve({ environmentId: 'env-owned' })).toBe('sbx_owned')
  expect(resolve({ environmentId: 'env-paired' })).toBe('sbx_paired')
  expect(resolve({ workspaceId: 'ws-1' })).toBe('sbx_paired')
})

it('refuses malformed ids and unknown targets', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver validates untrusted IPC input of any shape.
  const resolve = (args: unknown) => resolveGitAccessSandbox('/tmp/u', args as never)
  for (const args of [
    { sandboxId: '../x' },
    { sandboxId: 'a'.repeat(65) },
    { environmentId: 'nope' },
    { environmentId: '' },
    { workspaceId: 'ws-2' },
    undefined
  ]) {
    expect(resolve(args)).toBeNull()
  }
})
