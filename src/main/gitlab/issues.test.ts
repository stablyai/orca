import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const {
  glabExecFileAsyncMock,
  glabApiWithHeadersMock,
  getIssueProjectRefMock,
  resolveIssueSourceMock,
  getGlabKnownHostsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  glabApiWithHeadersMock: vi.fn(),
  getIssueProjectRefMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    glabApiWithHeaders: glabApiWithHeadersMock,
    getIssueProjectRef: getIssueProjectRefMock,
    resolveIssueSource: resolveIssueSourceMock,
    getGlabKnownHosts: getGlabKnownHostsMock,
    acquire: acquireMock,
    release: releaseMock
  }
})
import { getIssue, listIssues } from './issues'
import { updateIssue } from './issue-update'

describe('gitlab issue operations', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    glabApiWithHeadersMock.mockReset()
    getIssueProjectRefMock.mockReset()
    resolveIssueSourceMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueProjectRefMock(),
      fellBack: false
    }))
  })

  it('returns an isolated not_found error (never a cwd-inferred glab call) when the project is unresolved', async () => {
    // Unresolved SSH projects must return an isolated error without attempting local cwd inference.
    getIssueProjectRefMock.mockResolvedValueOnce(null)

    const result = await listIssues('/repo-root', 5, undefined, 'opened', '@me')

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('not_found')
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })

  it('returns null for getIssue (and spawns no glab call) when the project is unresolved', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce(null)

    await expect(getIssue('/repo-root', 7)).resolves.toBeNull()
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  // issue update rejects --hostname; pass the instance through GITLAB_HOST.

  // glab already-closed success exits 0; an already substring must not hide a real rejection.
  it('updateIssue reports a failed close even when its text says "already"', async () => {
    getIssueProjectRefMock.mockResolvedValueOnce({ host: 'gitlab.com', path: 'stablyai/orca' })
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('Issue is already closed'))

    await expect(updateIssue('/repo-root', 5, { state: 'closed' })).resolves.toMatchObject({
      ok: false
    })
  })
})
