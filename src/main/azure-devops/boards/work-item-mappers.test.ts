import { describe, expect, it } from 'vitest'
import { BASE_WORK_ITEM_FIELDS, mapAzureDevOpsWorkItem } from './work-item-mappers'
import { rawWorkItem } from './test-fixtures'

const webUrl = (id: number) => `https://dev.azure.com/acme/Project/_workitems/edit/${id}`

describe('mapAzureDevOpsWorkItem', () => {
  it('maps core fields, identity, tags and parent', () => {
    const item = mapAzureDevOpsWorkItem(
      rawWorkItem(288, {
        'System.WorkItemType': 'Feature',
        'System.Title': 'Phase 2',
        'System.State': 'In Progress',
        'System.AssignedTo': {
          displayName: 'Ada Lovelace',
          uniqueName: 'bobo@example.com',
          imageUrl: 'https://img/bobo'
        },
        'System.AreaPath': 'Project\\pos_portal',
        'System.IterationPath': 'Project\\2026',
        'System.Tags': 'triage; needs-info',
        'System.Parent': 70,
        'Microsoft.VSTS.Common.StackRank': 1999.5,
        'WEF_ABC_Kanban.Column': 'Dev (staging)'
      }),
      webUrl
    )
    expect(item).toEqual({
      id: 288,
      rev: 3,
      workItemType: 'Feature',
      title: 'Phase 2',
      state: 'In Progress',
      assignedTo: {
        displayName: 'Ada Lovelace',
        uniqueName: 'bobo@example.com',
        imageUrl: 'https://img/bobo'
      },
      areaPath: 'Project\\pos_portal',
      iterationPath: 'Project\\2026',
      tags: ['triage', 'needs-info'],
      parentId: 70,
      stackRank: 1999.5,
      url: 'https://dev.azure.com/acme/Project/_workitems/edit/288',
      fields: expect.objectContaining({
        'WEF_ABC_Kanban.Column': 'Dev (staging)',
        'System.Id': 288
      })
    })
  })

  it('tolerates missing optional fields', () => {
    const item = mapAzureDevOpsWorkItem(
      rawWorkItem(5, {
        'System.WorkItemType': 'Task',
        'System.Title': 'T',
        'System.State': 'To Do'
      }),
      webUrl
    )
    expect(item).toMatchObject({
      assignedTo: null,
      tags: [],
      parentId: null,
      stackRank: null,
      areaPath: '',
      iterationPath: ''
    })
  })

  it('rejects payloads without id or type', () => {
    expect(mapAzureDevOpsWorkItem({ fields: { 'System.Title': 'x' } }, webUrl)).toBeNull()
  })

  it('exposes the base field list used for hydration', () => {
    expect(BASE_WORK_ITEM_FIELDS).toEqual([
      'System.Id',
      'System.Rev',
      'System.WorkItemType',
      'System.Title',
      'System.State',
      'System.AssignedTo',
      'System.AreaPath',
      'System.IterationPath',
      'System.Tags',
      'System.Parent',
      'Microsoft.VSTS.Common.StackRank'
    ])
  })
})
