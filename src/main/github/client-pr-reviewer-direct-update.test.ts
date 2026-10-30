import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  resolve: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  invalidate: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  acquire: mocks.acquire,
  release: mocks.release
}))
vi.mock('./github-api-repository', () => ({ resolveGitHubRepoExecution: mocks.resolve }))
vi.mock('./pr-mutation-review-invalidation', () => ({
  invalidateReviewLookupsAfterPRMutation: mocks.invalidate
}))

import { removePRReviewers, requestPRReviewers } from './client/update/pr-reviewers'

const operations = [
  { name: 'add', method: 'POST', flag: '--add-reviewer', run: requestPRReviewers },
  { name: 'remove', method: 'DELETE', flag: '--remove-reviewer', run: removePRReviewers }
]
const repository = { owner: 'acme', repo: 'widgets', host: 'github.example.test' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.exec.mockResolvedValue({ stdout: '{}' })
  mocks.resolve.mockResolvedValue({
    ownerRepo: repository,
    ghOptions: { connectionId: 'ssh-1', host: repository.host, wslDistro: 'Ubuntu' }
  })
})

describe.each(operations)('$name reviewer mutation', ({ method, flag, run }) => {
  it('uses one direct mutation for known user logins and retains routing and invalidation', async () => {
    expect(
      await run('/folder', 42, [' alice ', 'bob', ''], 'ssh-1', repository, { wslDistro: 'Ubuntu' })
    ).toEqual({ ok: true })
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    const [args, options] = mocks.exec.mock.calls[0]
    expect(args).toEqual([
      'api',
      '-X',
      method,
      'repos/acme/widgets/pulls/42/requested_reviewers',
      '--raw-field',
      'reviewers[]=alice',
      '--raw-field',
      'reviewers[]=bob'
    ])
    expect({
      connectionId: options.connectionId,
      host: options.host,
      wslDistro: options.wslDistro
    }).toEqual({ connectionId: 'ssh-1', host: 'github.example.test', wslDistro: 'Ubuntu' })
    expect(options.env.GH_PROMPT_DISABLED).toBe('1')
    expect(mocks.resolve).toHaveBeenCalledWith('/folder', repository, 'ssh-1', {
      wslDistro: 'Ubuntu'
    })
    expect(mocks.acquire).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenCalledTimes(1)
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith('/folder', 'ssh-1')
  })

  it.each(['acme/team', '@copilot', '@me', 'copilot-pull-request-reviewer[bot]', 'alice,bob'])(
    'retains CLI interpretation for special syntax: %s',
    async (reviewer) => {
      expect(await run('/folder', 42, [reviewer, 'ordinary'])).toEqual({ ok: true })
      expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(
        ['pr', 'edit', '42', flag, `${reviewer},ordinary`, '--repo', 'acme/widgets'],
        expect.anything()
      )
    }
  )
})
