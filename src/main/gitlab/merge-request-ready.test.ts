import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute, release } = vi.hoisted(() => ({ execute: vi.fn(), release: vi.fn() }))
vi.mock('./gl-utils', () => ({
  acquire: vi.fn(),
  release,
  glabExecFileAsync: execute,
  glabHostnameArgs: () => ['--hostname', 'git.internal'],
  glabRepoExecOptions: () => ({ connectionId: 'ssh-1' }),
  classifyGlabError: (message: string) => ({ message })
}))
vi.mock('./merge-request-project-resolution', () => ({
  withProjectRef: async (
    _repo: string,
    _preference: unknown,
    _connection: unknown,
    _project: unknown,
    action: (project: { host: string; path: string }) => unknown
  ) => action({ host: 'git.internal', path: 'group/project' })
}))
import { updateMR } from './merge-request-update'

const mutation = { mergeRequest: { iid: '12' }, errors: [] }
const ready = { data: { mergeRequestSetDraft: mutation } }
const unknownField = {
  message: "Field 'mergeRequestSetDraft' doesn't exist on type 'Mutation'",
  extensions: { code: 'undefinedField', typeName: 'Mutation', fieldName: 'mergeRequestSetDraft' }
}
function response(body: unknown, status = 200): string {
  return `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${typeof body === 'string' ? body : JSON.stringify(body)}`
}
function rejected(body: unknown, status = 200, stderr = 'glab: request failed'): Error {
  return Object.assign(new Error(stderr), { code: 1, stdout: response(body, status), stderr })
}
const combined = { readyForReview: true as const, body: 'Description', addLabels: ['review'] }

// Error envelopes follow the source-backed GitLab schemas; nonzero transport is recorded with real glab.
describe('GitLab readiness title ownership', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    new Error('timeout while contacting GitLab'),
    rejected({ message: '401 Unauthorized' }, 401),
    rejected({ errors: [{ message: 'Forbidden' }] }, 404, 'glab: Forbidden'),
    rejected('Bad Gateway', 502),
    rejected({ errors: [{ message: 'Invalid MergeRequestSetDraftInput' }] }),
    rejected({
      errors: [
        { ...unknownField, extensions: { ...unknownField.extensions, fieldName: 'otherMutation' } }
      ]
    }),
    rejected({ errors: [unknownField, { message: 'Forbidden' }] }),
    rejected({ errors: [{ message: 'Not found!' }] }),
    Object.assign(rejected({ errors: [unknownField] }), { killed: true }),
    rejected(ready)
  ])('never retries or falls back after an uncertain or unrelated failure: %s', async (error) => {
    execute.mockRejectedValueOnce(error)
    await expect(updateMR('/repo', 12, { readyForReview: true })).resolves.toMatchObject({
      ok: false
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each([
    'not-json',
    null,
    { data: {} },
    { data: { mergeRequestSetDraft: { ...mutation, mergeRequest: null } } },
    { data: { mergeRequestSetDraft: { ...mutation, errors: ['denied'] } } },
    { ...ready, errors: [{ message: 'error' }] }
  ])('rejects an unconfirmed mutation result without title fallback: %s', async (body) => {
    execute.mockResolvedValueOnce({ stdout: response(body) })
    await expect(updateMR('/repo', 12, { readyForReview: true })).resolves.toMatchObject({
      ok: false
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('retains the existing title-plus-readiness rejection', async () => {
    await expect(
      updateMR('/repo', 12, { readyForReview: true, title: 'Rename' })
    ).resolves.toMatchObject({
      ok: false,
      error: 'Cannot update the title while marking a merge request ready'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('identifies metadata to retry when readiness succeeded before metadata failed', async () => {
    execute
      .mockResolvedValueOnce({ stdout: response(ready) })
      .mockRejectedValueOnce(new Error('timeout'))
    await expect(updateMR('/repo', 12, combined)).resolves.toEqual({
      ok: false,
      error:
        'GitLab marked the merge request ready, but could not confirm the description and labels update. Retry only those edits.'
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[0][0]).toContain('graphql')
    expect(execute.mock.calls[1][0]).toContain('description=Description')
  })
})
