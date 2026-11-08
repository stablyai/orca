import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), graphql: vi.fn() }))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  ghRepoExecOptions: () => ({}),
  githubRepoContext: () => ({})
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: () => {}
}))
vi.mock('./project-view/internals', () => ({
  assertPositiveInt: () => ({ ok: true }),
  validateSlugArgs: () => ({ ok: true }),
  projectGhExecOptions: () => ({}),
  runGraphql: mocks.graphql
}))
import { getPRMetadata } from './pull-request-file-data'
import { getWorkItemDetailsBySlug } from './project-view/work-item-details'

const body =
  '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
const html =
  '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
const expectedMap = {
  'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
    'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
}
beforeEach(() => {
  mocks.exec.mockReset()
  mocks.graphql.mockReset()
})

it('gets PR metadata images in its existing uncached full-media read', async () => {
  mocks.exec.mockResolvedValueOnce({
    stdout: JSON.stringify({ body, body_html: html, head: { sha: 'head' } })
  })
  const metadata = await getPRMetadata('/repo', 7, { owner: 'acme', repo: 'widgets' })
  expect(metadata).toMatchObject({ body, headSha: 'head', bodyImageUrls: expectedMap })
  expect(mocks.exec).toHaveBeenCalledTimes(1)
  expect(mocks.exec.mock.calls[0][0]).toEqual([
    'api',
    '-H',
    'Accept: application/vnd.github.full+json',
    'repos/acme/widgets/pulls/7'
  ])
})

it.each(['issue', 'pr'] as const)(
  'gets slug %s body and comment images in one existing read',
  async (type) => {
    mocks.graphql.mockResolvedValueOnce({
      ok: true,
      data: {
        repository: {
          [type === 'issue' ? 'issue' : 'pullRequest']: {
            id: 'ITEM',
            body,
            bodyHTML: html,
            comments: { nodes: [{ databaseId: 1, body, bodyHTML: html }] }
          }
        }
      }
    })
    const result = await getWorkItemDetailsBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      type
    })
    expect(result.ok && result.details.body).toBe(body)
    expect(result.ok && result.details.bodyImageUrls).toEqual(expectedMap)
    expect(result.ok && result.details.comments[0].bodyImageUrls).toEqual(expectedMap)
    expect(mocks.graphql).toHaveBeenCalledTimes(1)
    expect(mocks.exec).not.toHaveBeenCalled()
  }
)

it.each(['issue', 'pr'] as const)(
  'recovers available slug %s data without trusting failed HTML',
  async (type) => {
    const root = type === 'issue' ? 'issue' : 'pullRequest'
    mocks.graphql.mockResolvedValueOnce({
      ok: false,
      error: { type: 'unknown', message: 'field error' },
      raw: {
        stdout: JSON.stringify({
          data: {
            repository: {
              [root]: {
                id: 'ITEM',
                body,
                bodyHTML: html,
                comments: {
                  nodes: [
                    { databaseId: 1, body, bodyHTML: html },
                    { databaseId: 2, body, bodyHTML: html }
                  ]
                }
              }
            }
          },
          errors: [
            { path: ['repository', root, 'bodyHTML'] },
            { path: ['repository', root, 'comments', 'nodes', 0, 'bodyHTML'] }
          ]
        }),
        stderr: ''
      }
    })
    const result = await getWorkItemDetailsBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      type
    })
    expect(result.ok && result.details.body).toBe(body)
    expect(result.ok && result.details.bodyImageUrls).toBeUndefined()
    expect(result.ok && result.details.comments[0].bodyImageUrls).toBeUndefined()
    expect(result.ok && result.details.comments[1].bodyImageUrls).toEqual(expectedMap)
    expect(mocks.graphql).toHaveBeenCalledTimes(1)
    expect(mocks.exec).not.toHaveBeenCalled()
  }
)

it.each(['null parent', 'required field', 'pathless'] as const)(
  'keeps the original slug failure for %s',
  async (input) => {
    const error = { type: 'unknown', message: 'original failure' }
    mocks.graphql.mockResolvedValueOnce({
      ok: false,
      error,
      raw: {
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: { issue: input === 'null parent' ? null : { body, bodyHTML: html } }
          },
          errors: [
            {
              path:
                input === 'pathless'
                  ? undefined
                  : ['repository', 'issue', input === 'required field' ? 'body' : 'bodyHTML']
            }
          ]
        })
      }
    })
    await expect(
      getWorkItemDetailsBySlug({ owner: 'acme', repo: 'widgets', number: 7, type: 'issue' })
    ).resolves.toEqual({ ok: false, error: { type: 'unknown', message: 'original failure' } })
  }
)
