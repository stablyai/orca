import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return { ...actual, glabExecFileAsync: glabExecFileAsyncMock }
})

import { fetchMRApproval } from './mr-reviewers-and-approvals'

const projectRef = { host: 'gitlab.com', path: 'g/p' }

describe('fetchMRApproval', () => {
  beforeEach(() => glabExecFileAsyncMock.mockReset())

  it('maps the current user approval fields from /approvals', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        approvals_required: 2,
        approvals_left: 1,
        approved_by: [{ user: { id: 1, username: 'a' } }],
        user_can_approve: true,
        user_has_approved: false
      })
    })
    await expect(fetchMRApproval('/repo', projectRef, 5)).resolves.toEqual({
      approvalsRequired: 2,
      approvalsLeft: 1,
      approvedCount: 1,
      userCanApprove: true,
      userHasApproved: false
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'projects/g%2Fp/merge_requests/5/approvals'],
      { cwd: '/repo' }
    )
  })

  it('passes --hostname for an SSH-selected host', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ user_can_approve: false, user_has_approved: false })
    })
    await fetchMRApproval('/repo', { host: 'git.internal', path: 'g/p' }, 3, 'conn-1')
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--hostname', 'git.internal', 'projects/g%2Fp/merge_requests/3/approvals'],
      {}
    )
  })

  it('returns undefined when GitLab omits the user approval fields', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ approvals_required: 1, approvals_left: 1 })
    })
    await expect(fetchMRApproval('/repo', projectRef, 5)).resolves.toBeUndefined()
  })

  it.each(['null', '"x"', '{'])('returns undefined for unusable JSON %s', async (stdout) => {
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout })
    await expect(fetchMRApproval('/repo', projectRef, 5)).resolves.toBeUndefined()
  })

  it('returns undefined when glab fails', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 500'))
    await expect(fetchMRApproval('/repo', projectRef, 5)).resolves.toBeUndefined()
  })
})
