import { beforeEach, describe, expect, it, vi } from 'vitest'
import { argsLookIdempotent } from '../../git/command-runner/hosted-cli/gh-idempotency'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('../requests/glab-request-admission', () => ({ acquire: vi.fn(), release: vi.fn() }))

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../projects/gitlab-project-ref-resolution', () => ({
  glabHostnameArgs: vi.fn((projectRef: { host: string }) => ['--hostname', projectRef.host]),
  glabRepoExecOptions: vi.fn(() => ({}))
}))

import { updateMR } from './merge-request-update'

const projectRef = { host: 'git.internal', path: 'g/p' }

describe('updateMR approval', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
  })

  it.each(['approve', 'unapprove'] as const)('POSTs %s for the merge request', async (approval) => {
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}' })

    await expect(
      updateMR('/repo', 12, { approval }, 'upstream', 'conn-1', projectRef)
    ).resolves.toEqual({ ok: true })

    expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--hostname', 'git.internal', '-X', 'POST', `projects/g%2Fp/merge_requests/12/${approval}`],
      {}
    )
  })

  it('returns a classified error when the approval POST fails', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('401 Unauthorized'))
    const result = await updateMR('/repo', 12, { approval: 'approve' }, 'upstream', 'conn-1', projectRef)
    expect(result.ok).toBe(false)
    expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
  })

  it('refuses to combine approval with other updates', async () => {
    await expect(
      updateMR('/repo', 12, { approval: 'approve', title: 'x' }, 'upstream', 'conn-1', projectRef)
    ).resolves.toEqual({
      ok: false,
      error: 'Approval cannot be combined with other merge request updates'
    })
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })
})

describe('approval POST retry safety', () => {
  it.each(['approve', 'unapprove'])(
    '%s is classified non-idempotent so glab never auto-retries it',
    (verb) => {
      expect(
        argsLookIdempotent([
          'api',
          '--hostname',
          'h',
          '-X',
          'POST',
          `projects/g%2Fp/merge_requests/1/${verb}`
        ])
      ).toBe(false)
    }
  )
})
