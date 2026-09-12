import { beforeEach, describe, expect, it, vi } from 'vitest'
import { countUnresolvedDiscussions, fetchUnresolvedDiscussionCount } from './mr-discussion-notes'

describe('countUnresolvedDiscussions', () => {
  it('counts discussions whose root note is unresolved and human-authored', () => {
    expect(
      countUnresolvedDiscussions([
        {
          notes: [
            {
              resolvable: true,
              resolved: false,
              author: { username: 'alice' }
            }
          ]
        },
        {
          notes: [{ resolvable: true, resolved: true, author: { username: 'alice' } }]
        },
        // Why: non-resolvable notes (plain comments) never block review.
        { notes: [{ resolvable: false, author: { username: 'alice' } }] },
        {
          notes: [
            {
              resolvable: true,
              resolved: false,
              author: { username: 'ci', state: 'bot' }
            }
          ]
        },
        {
          notes: [
            { system: true, body: 'changed the description' },
            { resolvable: true, resolved: false, author: { username: 'bob' } }
          ]
        }
      ])
    ).toBe(2)
  })
})

const { exec, repoOptions, hostnameArgs } = vi.hoisted(() => ({
  exec: vi.fn(),
  repoOptions: vi.fn(),
  hostnameArgs: vi.fn()
}))
vi.mock('./gl-utils', () => ({
  glabExecFileAsync: exec,
  glabRepoExecOptions: repoOptions,
  glabHostnameArgs: hostnameArgs
}))

describe('fetchUnresolvedDiscussionCount', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    hostnameArgs.mockReturnValue(['--hostname', 'gitlab.example.com'])
    repoOptions.mockReturnValue({ cwd: '/workspace' })
  })

  it('includes unresolved discussions on page two and preserves execution options', async () => {
    exec
      .mockResolvedValueOnce({
        stdout: JSON.stringify(
          Array.from({ length: 100 }, () => ({
            notes: [{ resolvable: true, resolved: true }]
          }))
        )
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { notes: [{ resolvable: true, resolved: false, author: { username: 'alice' } }] }
        ])
      })
    const project = { host: 'gitlab.example.com', path: 'g/p' }
    const options = { wslDistro: 'Ubuntu' }
    expect(await fetchUnresolvedDiscussionCount('/workspace', project, 12, 'ssh-id', options)).toBe(
      1
    )
    expect(exec).toHaveBeenCalledTimes(2)
    expect(exec.mock.calls[1][0]).toEqual([
      'api',
      '--hostname',
      'gitlab.example.com',
      'projects/g%2Fp/merge_requests/12/discussions?per_page=100&page=2'
    ])
    expect(repoOptions).toHaveBeenLastCalledWith('/workspace', 'ssh-id', options)
    expect(hostnameArgs).toHaveBeenLastCalledWith(project, 'ssh-id')
  })

  it('rejects a later page failure instead of returning a partial count', async () => {
    exec
      .mockResolvedValueOnce({
        stdout: JSON.stringify(
          Array.from({ length: 100 }, () => ({
            notes: [{ resolvable: true, resolved: false }]
          }))
        )
      })
      .mockRejectedValueOnce(new Error('offline'))
    await expect(
      fetchUnresolvedDiscussionCount('/workspace', { host: 'gitlab.com', path: 'g/p' }, 12)
    ).rejects.toThrow('offline')
  })
})
