import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import { setFilesystemHostReadClientForTests } from '../filesystem-host/filesystem-host-read-client'
import { getDefaultRepoHookSettings } from '../../shared/constants'

const repo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000000',
  addedAt: 0,
  hookSettings: { ...getDefaultRepoHookSettings(), scripts: {} }
}
afterEach(() => setFilesystemHostReadClientForTests(null))
it('uses a bounded document read for hook parsing and setup trust without caching across edits', async () => {
  const readOrcaYaml = vi
    .fn()
    .mockResolvedValueOnce('scripts:\n  setup: echo first\n')
    .mockResolvedValueOnce('scripts:\n  setup: echo second\n')
  setFilesystemHostReadClientForTests({
    canonicalizePath: async (path) => path,
    readOrcaYaml,
    readKeybindings: async () => '',
    readSnapshotFile: async () => Buffer.alloc(0),
    prepareRateLimitPtyCwd: async (path) => path
  })
  const commands = new RuntimeRepositoryHooksCommands({ resolveRepo: async () => repo })
  expect((await commands.getRepoHooks('repo')).setupTrust?.scriptContent).toContain('echo first')
  expect((await commands.getRepoHooks('repo')).setupTrust?.scriptContent).toContain('echo second')
  expect(readOrcaYaml).toHaveBeenCalledTimes(2)
})
it('fails closed when the owning host cannot read the document', async () => {
  const commands = new RuntimeRepositoryHooksCommands({ resolveRepo: async () => repo })
  setFilesystemHostReadClientForTests(null)
  await expect(commands.getRepoHooks('repo')).rejects.toThrow('Filesystem host is unavailable')
})
