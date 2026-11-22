import { describe, expect, it, vi } from 'vitest'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { getPRDetailContext } from './pull-request-detail-context'

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn()
}))

const repository = { owner: 'acme', repo: 'widgets', host: 'github.example.test' }
const pr = {
  body: 'Describe the fix.',
  headRefOid: '0123456789abcdef0123456789abcdef01234567',
  baseRefOid: 'fedcba9876543210fedcba9876543210fedcba98',
  participants: { nodes: [] }
}

describe('getPRDetailContext', () => {
  it('keeps description and commit IDs when file view state is unavailable', async () => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: { repository: { pullRequest: pr, viewedPullRequest: null } },
        errors: [{ path: ['repository', 'viewedPullRequest', 'files'] }]
      }),
      stderr: ''
    })

    await expect(getPRDetailContext('/workspace', 27, repository)).resolves.toEqual({
      metadata: {
        body: 'Describe the fix.',
        headSha: '0123456789abcdef0123456789abcdef01234567',
        baseSha: 'fedcba9876543210fedcba9876543210fedcba98'
      },
      participants: [],
      viewedStates: null
    })
  })

  it('defers a body containing a GitHub attachment to the rendered-body read', async () => {
    const body =
      '![screenshot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ data: { repository: { pullRequest: { ...pr, body } } } }),
      stderr: ''
    })

    await expect(getPRDetailContext('/workspace', 27, repository)).resolves.toMatchObject({
      metadata: undefined,
      participants: []
    })
  })
})
