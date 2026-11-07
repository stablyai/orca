import { expect, it, vi } from 'vitest'
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
  acquire: async () => {},
  release: () => {},
  assertPositiveInt: () => ({ ok: true }),
  validateSlugArgs: () => ({ ok: true }),
  projectGhExecOptions: () => ({}),
  runGraphql: mocks.graphql
}))
import { getPRMetadata } from './pull-request-file-data'
import { getWorkItemDetailsBySlug } from './project-view/work-item-details'

it('enriches PR metadata and slug details using their fetched node IDs', async () => {
  const body =
    '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
  mocks.exec.mockImplementation(async (args: string[]) => ({
    stdout: JSON.stringify(
      args.includes('--input')
        ? {
            data: {
              nodes: ['PR', 'C'].map((id) => ({
                id,
                body,
                bodyHTML:
                  '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
              }))
            }
          }
        : { node_id: 'PR', body, head: { sha: 'head' } }
    )
  }))
  mocks.graphql.mockResolvedValue({
    ok: true,
    data: {
      repository: {
        pullRequest: { id: 'PR', body, comments: { nodes: [{ id: 'C', databaseId: 1, body }] } }
      }
    }
  })
  const metadata = await getPRMetadata('/repo', 7, { owner: 'acme', repo: 'widgets' })
  const project = await getWorkItemDetailsBySlug({
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    type: 'pr'
  })
  expect(metadata).toMatchObject({
    body: '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)',
    headSha: 'head',
    bodyImageUrls: {
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    }
  })
  expect(project.ok && project.details.bodyImageUrls).toEqual(metadata.bodyImageUrls)
  expect(project.ok && project.details.comments[0].bodyImageUrls).toEqual(metadata.bodyImageUrls)
})
