import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAzureDevOpsWorkItemDetail } from './work-item-client'
import { CLOUD_REPO, installAzureDevOpsFetchFixture } from './test-fixtures'

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('getAzureDevOpsWorkItemDetail', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
  })

  it('reads description, acceptance criteria, dates and relations', async () => {
    const { calls } = installAzureDevOpsFetchFixture({
      '/acme/Project/_apis/wit/workitems/288': {
        id: 288,
        rev: 7,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': 'Phase 2',
          'System.State': 'Committed',
          'System.Description': '<div>Do <b>it</b></div>',
          'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>done</li></ul>',
          'System.CreatedDate': '2026-08-01T00:00:00Z',
          'System.ChangedDate': '2026-09-01T00:00:00Z',
          'System.Parent': 70
        },
        relations: [
          {
            rel: 'System.LinkTypes.Hierarchy-Reverse',
            url: 'https://dev.azure.com/acme/_apis/wit/workItems/70'
          },
          {
            rel: 'System.LinkTypes.Hierarchy-Forward',
            url: 'https://dev.azure.com/acme/_apis/wit/workItems/301'
          },
          {
            rel: 'System.LinkTypes.Hierarchy-Forward',
            url: 'https://dev.azure.com/acme/_apis/wit/workItems/302'
          },
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/7a66fe53-0000-0000-0000-000000000000%2Ff3c6564e-0000-0000-0000-000000000000%2F171',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })

    const detail = await getAzureDevOpsWorkItemDetail(CLOUD_REPO, 288)

    expect(detail).toMatchObject({
      id: 288,
      title: 'Phase 2',
      parentId: 70,
      descriptionHtml: '<div>Do <b>it</b></div>',
      acceptanceCriteriaHtml: '<ul><li>done</li></ul>',
      childIds: [301, 302],
      pullRequestLinks: [
        {
          id: 171,
          url: 'https://dev.azure.com/acme/7a66fe53-0000-0000-0000-000000000000/_git/f3c6564e-0000-0000-0000-000000000000/pullrequest/171'
        }
      ],
      createdDate: '2026-08-01T00:00:00Z',
      changedDate: '2026-09-01T00:00:00Z'
    })
    expect(calls[0].searchParams.get('$expand')).toBe('all')
  })

  it('returns null when the item is missing', async () => {
    installAzureDevOpsFetchFixture({})
    await expect(getAzureDevOpsWorkItemDetail(CLOUD_REPO, 999)).resolves.toBeNull()
  })

  it('drops a pull request link whose artifact url is malformed instead of failing the item', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/_apis/wit/workitems/288': {
        id: 288,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': 'x',
          'System.State': 'New'
        },
        relations: [
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/abc%',
            attributes: { name: 'Pull Request' }
          },
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/p%2Fr%2F9',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })
    const detail = await getAzureDevOpsWorkItemDetail(CLOUD_REPO, 288)
    expect(detail?.pullRequestLinks).toEqual([
      { id: 9, url: 'https://dev.azure.com/acme/p/_git/r/pullrequest/9' }
    ])
  })

  it('links a pull request from another repository of the project by its own ids', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/_apis/wit/workitems/288': {
        id: 288,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': 'x',
          'System.State': 'New'
        },
        relations: [
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/proj-guid%2Fother-repo-guid%2F42',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })
    const detail = await getAzureDevOpsWorkItemDetail(CLOUD_REPO, 288)
    expect(detail?.pullRequestLinks).toEqual([
      { id: 42, url: 'https://dev.azure.com/acme/proj-guid/_git/other-repo-guid/pullrequest/42' }
    ])
  })

  it('builds cross-repo pull request links under an on-prem collection', async () => {
    installAzureDevOpsFetchFixture({
      '/tfs/DefaultCollection/Project/_apis/wit/workitems/288': {
        id: 288,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.Title': 'x',
          'System.State': 'New'
        },
        relations: [
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F7',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })
    const detail = await getAzureDevOpsWorkItemDetail(
      {
        host: 'tfs.example.com',
        organization: null,
        project: 'Project',
        repository: 'repo',
        apiBaseUrl: 'https://tfs.example.com/tfs/DefaultCollection/Project',
        webBaseUrl: 'https://tfs.example.com/tfs/DefaultCollection/Project/_git/repo'
      },
      288
    )
    expect(detail?.pullRequestLinks).toEqual([
      {
        id: 7,
        url: 'https://tfs.example.com/tfs/DefaultCollection/proj-guid/_git/repo-guid/pullrequest/7'
      }
    ])
  })

  it('ignores a pull request artifact url with an empty trailing segment', async () => {
    installAzureDevOpsFetchFixture({
      '/acme/Project/_apis/wit/workitems/288': {
        id: 288,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.Title': 'x',
          'System.State': 'New'
        },
        relations: [
          {
            rel: 'ArtifactLink',
            url: 'vstfs:///Git/PullRequestId/p%2Fr%2F',
            attributes: { name: 'Pull Request' }
          }
        ]
      }
    })
    const detail = await getAzureDevOpsWorkItemDetail(CLOUD_REPO, 288)
    expect(detail?.pullRequestLinks).toEqual([])
  })
})
