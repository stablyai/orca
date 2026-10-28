import { afterEach, expect, it, vi } from 'vitest'
import { REPO_HANDLERS } from './repo'
import { PROJECT_HANDLERS } from './project'
import { RuntimeClient } from '../runtime-client'

vi.mock('../repo-path-arguments', () => ({
  resolveRepoPathArgument: (path: string, cwd: string) => (path === '.' ? cwd : path)
}))
afterEach(() => vi.restoreAllMocks())
it('uses the first-use budget for resolved local UNC Add and setup, leaving explicit remote budgets alone', async () => {
  const client = new RuntimeClient('/tmp/pr28977-timeouts', 60_000, null, null)
  const call = vi.spyOn(client, 'call').mockResolvedValue({
    id: 'reply',
    ok: true,
    result: { projects: [] },
    _meta: { runtimeId: 'test' }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const cwd = '\\\\wsl$\\Ubuntu\\home\\me\\repo'
  const context = {
    client,
    cwd,
    json: true,
    flags: new Map<string, string | boolean>([['path', '.']])
  }
  await REPO_HANDLERS['repo add'](context)
  expect(call).toHaveBeenLastCalledWith('repo.add', { path: cwd }, { timeoutMs: 600_000 })
  context.flags.set('host', 'local')
  context.flags.set('project', 'owner-project')
  await PROJECT_HANDLERS['project setup-existing-folder'](context)
  expect(call).toHaveBeenLastCalledWith(
    'projectHostSetup.setupExistingFolder',
    expect.objectContaining({ path: cwd }),
    { timeoutMs: 600_000 }
  )
  vi.spyOn(client, 'isRemote', 'get').mockReturnValue(true)
  context.flags.set('path', cwd)
  await REPO_HANDLERS['repo add'](context)
  expect(call).toHaveBeenLastCalledWith('repo.add', { path: cwd })
})
