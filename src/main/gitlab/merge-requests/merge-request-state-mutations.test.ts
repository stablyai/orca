import { expect, it, vi } from 'vitest'
import { closeMR } from './merge-request-state-mutations'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn(async () => ({ stdout: '', stderr: '' }))
}))
vi.mock('../../github/pull-requests/refresh/pr-mutation-review-invalidation', () => ({
  invalidateReviewLookupsAfterPRMutation: vi.fn()
}))

it('targets the project host for local repositories, not glab default host', async () => {
  await closeMR('/repo', 7, undefined, null, { host: 'gitlab.example.internal', path: 'grp/app' })

  const [args, options] = vi.mocked(glabExecFileAsync).mock.calls[0] ?? []
  expect(args).toEqual(['mr', 'close', '7', '-R', 'grp/app'])
  expect(options).toMatchObject({ cwd: '/repo', env: { GITLAB_HOST: 'gitlab.example.internal' } })
})
