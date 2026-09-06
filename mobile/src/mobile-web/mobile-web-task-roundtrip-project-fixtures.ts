type HostResponse = { ok: true; result: unknown }

export function taskRoundtripProjectHostResponse(method: string): HostResponse | undefined {
  if (method === 'github.project.addIssueCommentBySlug') {
    return {
      ok: true,
      result: {
        ok: true,
        comment: {
          id: 22,
          author: 'octo',
          body: 'Added from hosted Tasks',
          createdAt: '2026-07-24T00:00:00Z'
        }
      }
    }
  }
  if (method === 'github.resolveReviewThread') {
    return { ok: true, result: true }
  }
  if (method === 'github.prChecks') {
    return {
      ok: true,
      result: [
        {
          name: 'Mobile checks',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/stablyai/orca/actions/runs/1'
        }
      ]
    }
  }
  if (method === 'github.setPRFileViewed') {
    return { ok: true, result: true }
  }
  if (method === 'github.prFileContents') {
    return {
      ok: true,
      result: {
        original: 'before\n',
        modified: 'after\n',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    }
  }
  if (method === 'github.addPRReviewComment') {
    return {
      ok: true,
      result: {
        ok: true,
        comment: {
          id: 24,
          author: 'octo',
          body: 'Inline comment',
          createdAt: '2026-07-24T00:00:00Z',
          path: 'src/file.ts',
          line: 7
        }
      }
    }
  }
  if (method === 'github.project.listAccessible') {
    return {
      ok: true,
      result: {
        ok: true,
        projects: [
          {
            id: 'project-node',
            host: 'github.com',
            owner: 'stablyai',
            ownerType: 'organization',
            number: 3,
            title: 'Mobile',
            url: 'https://github.com/orgs/stablyai/projects/3',
            source: 'viewer'
          }
        ]
      }
    }
  }
  if (method === 'github.project.listViews') {
    return {
      ok: true,
      result: {
        ok: true,
        views: [{ id: 'view-node', number: 1, name: 'Roadmap', layout: 'TABLE_LAYOUT' }]
      }
    }
  }
  if (method === 'github.project.resolveRef') {
    return {
      ok: true,
      result: {
        ok: true,
        owner: 'stablyai',
        ownerType: 'organization',
        number: 3,
        title: 'Mobile',
        host: 'github.com',
        viewNumber: 1
      }
    }
  }
  if (method === 'github.project.viewTable') {
    return { ok: true, result: { ok: true, data: projectTable() } }
  }
  if (method === 'github.project.workItemDetailsBySlug') {
    return {
      ok: true,
      result: {
        ok: true,
        details: {
          body: 'Project item details',
          comments: [],
          item: { labels: ['project'] },
          assignees: [],
          checks: [],
          files: []
        }
      }
    }
  }
  if (method === 'github.project.listLabelsBySlug') {
    return { ok: true, result: { ok: true, labels: ['project'] } }
  }
  if (method === 'github.project.listAssignableUsersBySlug') {
    return { ok: true, result: { ok: true, users: [{ login: 'octo', name: 'Octo' }] } }
  }
  if (method === 'github.project.listIssueTypesBySlug') {
    return {
      ok: true,
      result: {
        ok: true,
        types: [{ id: 'type-1', name: 'Bug', color: 'RED', description: 'Defect' }]
      }
    }
  }
  return undefined
}

function projectTable() {
  return {
    project: {
      id: 'project-node',
      host: 'github.com',
      owner: 'stablyai',
      ownerType: 'organization',
      number: 3,
      title: 'Mobile',
      url: 'https://github.com/orgs/stablyai/projects/3'
    },
    selectedView: {
      id: 'view-node',
      number: 1,
      name: 'Roadmap',
      filter: '',
      layout: 'TABLE_LAYOUT',
      fields: [{ kind: 'field', id: 'field-note', name: 'Note', dataType: 'TEXT' }],
      groupByFields: [],
      sortByFields: []
    },
    rows: [
      {
        id: 'project-item',
        itemType: 'ISSUE',
        content: {
          number: 7,
          title: 'Typed tasks',
          body: null,
          url: 'https://github.com/stablyai/orca/issues/7',
          state: 'OPEN',
          stateReason: null,
          isDraft: false,
          repository: 'stablyai/orca',
          issueType: null,
          labels: [],
          assignees: [],
          parentIssue: null
        },
        fieldValuesByFieldId: {},
        updatedAt: '2026-07-24T00:00:00Z',
        position: 0
      },
      {
        id: 'project-pr-item',
        itemType: 'PULL_REQUEST',
        content: {
          number: 8,
          title: 'Review typed tasks',
          body: null,
          url: 'https://github.com/stablyai/orca/pull/8',
          state: 'OPEN',
          stateReason: null,
          isDraft: false,
          repository: 'stablyai/orca',
          issueType: null,
          labels: [],
          assignees: [],
          parentIssue: null
        },
        fieldValuesByFieldId: {},
        updatedAt: '2026-07-24T00:00:00Z',
        position: 1
      }
    ],
    totalCount: 2,
    parentFieldDropped: false
  }
}
