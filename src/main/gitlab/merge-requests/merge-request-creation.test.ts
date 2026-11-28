import { expect, it, vi } from 'vitest'
import { createGitLabMergeRequest } from './merge-request-creation'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'

vi.mock('./merge-request-lookup', () => ({
  getProjectSlug: vi.fn(async () => ({ host: 'gitlab.example.internal', path: 'grp/app' }))
}))
vi.mock('../requests/glab-request-admission', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))
vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn(async () => ({
    stdout: 'https://gitlab.example.internal/grp/app/-/merge_requests/3',
    stderr: ''
  }))
}))

it('creates local merge requests on the project host, not glab default host', async () => {
  const result = await createGitLabMergeRequest(
    '/repo',
    { provider: 'gitlab', base: 'main', head: 'feature', title: 'Fix' },
    LOCAL_EXECUTION_HOST_ID
  )

  expect(result).toMatchObject({ ok: true, number: 3 })
  const [args, options] = vi.mocked(glabExecFileAsync).mock.calls[0] ?? []
  expect(args?.slice(0, 4)).toEqual(['mr', 'create', '-R', 'grp/app'])
  expect(args).not.toContain('--hostname')
  expect(options).toMatchObject({ cwd: '/repo', env: { GITLAB_HOST: 'gitlab.example.internal' } })
})
