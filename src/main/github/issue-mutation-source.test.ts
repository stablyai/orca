import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

const { ghExecFileAsyncMock, resolveIssueSourceMock, acquireMock, releaseMock } = vi.hoisted(
  () => ({
    ghExecFileAsyncMock: vi.fn(),
    resolveIssueSourceMock: vi.fn(),
    acquireMock: vi.fn(),
    releaseMock: vi.fn()
  })
)

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('./github-api-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubApiRepositoryModule>()),
  resolveIssueGitHubApiRepositorySource: resolveIssueSourceMock
}))

import { addIssueComment } from './issue-comment'
import { updateIssue } from './issue-update'

const ORIGIN = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
const UPSTREAM = { owner: 'upstream-owner', repo: 'widgets', host: 'github.com' }

describe('issue mutations follow the issue source preference', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    acquireMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockReset()
    resolveIssueSourceMock.mockReset()
    resolveIssueSourceMock.mockImplementation(async (_repoPath: string, preference: unknown) => ({
      source: preference === 'origin' ? ORIGIN : UPSTREAM,
      fellBack: false
    }))
  })

  it('posts issue comments to origin when origin is selected', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 1, user: { login: 'octo', avatar_url: '' }, body: 'hi' })
    })

    await expect(
      addIssueComment('/repo-root', 5, 'hi', null, null, {}, 'origin')
    ).resolves.toMatchObject({ ok: true })

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'origin', null, {})
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain(
      'repos/fork-owner/widgets/issues/5/comments'
    )
  })

  it('keeps an explicit owner/repo override ahead of the preference', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ id: 2, user: { login: 'octo', avatar_url: '' }, body: 'hi' })
    })

    await addIssueComment('/repo-root', 7, 'hi', null, UPSTREAM, {}, 'origin')

    expect(resolveIssueSourceMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain(
      'repos/upstream-owner/widgets/issues/7/comments'
    )
  })

  it('edits issues on origin when origin is selected', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 5, { body: 'Updated', addAssignees: ['octo'] }, null, {}, 'origin')
    ).resolves.toEqual({ ok: true })

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'origin', null, {})
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain('repos/fork-owner/widgets/issues/5')
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual([
      'issue',
      'edit',
      '5',
      '--repo',
      'fork-owner/widgets',
      '--add-assignee',
      'octo'
    ])
  })

  it('keeps the upstream-first default when no preference is set', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    await updateIssue('/repo-root', 5, { body: 'Updated' })

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', undefined, undefined, {})
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain('repos/upstream-owner/widgets/issues/5')
  })
})
