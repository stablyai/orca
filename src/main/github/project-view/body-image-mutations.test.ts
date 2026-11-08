import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  ghExecFileAsyncMock,
  noteRepositoryRateLimitSpendMock,
  projectHostAuthenticationErrorMock,
  repositoryRateLimitGuardMock,
  releaseMock,
  runGraphqlMock,
  runRestMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  projectHostAuthenticationErrorMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn(),
  releaseMock: vi.fn(),
  runGraphqlMock: vi.fn(),
  runRestMock: vi.fn()
}))

vi.mock('./internals', () => ({
  acquire: acquireMock,
  release: releaseMock,
  extractExecError: (err: unknown) => ({
    stderr: err instanceof Error ? err.message : String(err),
    stdout: ''
  }),
  ghExecFileAsync: ghExecFileAsyncMock,
  rateLimitGuard: () => ({ blocked: false }),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  projectHostAuthenticationError: projectHostAuthenticationErrorMock,
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  classifyProjectError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  rateLimitedError: () => ({ type: 'rate_limited', message: 'rate limited' }),
  runGraphql: runGraphqlMock,
  runRest: runRestMock,
  validateSlugArgs: (owner: string, repo: string) =>
    owner && repo ? { ok: true } : { ok: false, error: { type: 'validation_error' } },
  assertPositiveInt: (value: number, name: string) =>
    Number.isInteger(value) && value > 0
      ? { ok: true, value }
      : { ok: false, error: { type: 'validation_error', message: `${name} invalid` } }
}))

import { updateIssueBySlug } from './mutations'
import { updatePullRequestBySlug } from './pull-request-mutation'
import { addIssueCommentBySlug } from './issue-comment-mutations'

describe('Project accepted body representations', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    ghExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    noteRepositoryRateLimitSpendMock.mockReset()
    projectHostAuthenticationErrorMock.mockReset().mockResolvedValue(null)
    repositoryRateLimitGuardMock.mockReset().mockReturnValue({ blocked: false })
    releaseMock.mockReset()
    runRestMock.mockReset().mockResolvedValue({ ok: true, data: {} })
  })

  it.each([updateIssueBySlug, updatePullRequestBySlug])(
    'returns paired image sources after a body edit',
    async (update) => {
      const body =
        '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      runRestMock.mockResolvedValueOnce({
        ok: true,
        data: {
          body,
          body_html:
            '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
        }
      })
      const result = await update({ owner: 'acme', repo: 'widgets', number: 12, updates: { body } })
      expect(result).toEqual({
        ok: true,
        bodyImageUrls: {
          'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
            'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
        }
      })
      expect(runRestMock.mock.calls[0][0]).toContain(`body=${body}`)
      expect(runRestMock.mock.calls[0][0]).toContain('Accept: application/vnd.github.full+json')
    }
  )

  it('returns the paired source for a newly posted Project comment', async () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    runRestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 1,
        body,
        body_html:
          '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
      }
    })
    const result = await addIssueCommentBySlug({ owner: 'acme', repo: 'widgets', number: 12, body })
    expect(result.ok && result.comment.bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
  })

  it('does not attach a Project issue map from a different accepted body snapshot', async () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    runRestMock.mockResolvedValueOnce({
      ok: true,
      data: {
        body: `${body}\nchanged elsewhere`,
        body_html:
          '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
      }
    })
    await expect(
      updateIssueBySlug({ owner: 'acme', repo: 'widgets', number: 12, updates: { body } })
    ).resolves.toEqual({ ok: true, bodyImageUrls: undefined })
  })

  it('keeps an accepted PR body save successful without an optional representation', async () => {
    runRestMock.mockResolvedValueOnce({ ok: true, data: null })
    await expect(
      updatePullRequestBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        updates: {
          body: '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
        }
      })
    ).resolves.toEqual({ ok: true, bodyImageUrls: undefined })
  })

  it.each([null, true])(
    'finishes a Project compound save with unusable optional HTML (%s)',
    async (html) => {
      const body =
        '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      runRestMock.mockResolvedValueOnce({
        ok: true,
        data: html === null ? null : { body, body_html: html }
      })
      await expect(
        updateIssueBySlug({
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          updates: { body, addLabels: ['saved-label'] }
        })
      ).resolves.toEqual({ ok: true, bodyImageUrls: undefined })
      expect(runRestMock).toHaveBeenCalledWith(
        [
          '-X',
          'POST',
          'repos/acme/widgets/issues/12/labels',
          '--raw-field',
          'labels[]=saved-label'
        ],
        undefined,
        'core',
        { host: 'github.com' }
      )
    }
  )
})
