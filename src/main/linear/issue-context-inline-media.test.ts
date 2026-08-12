import { describe, expect, it } from 'vitest'
import type {
  LinearIssueChildNode,
  LinearIssueCommentNode,
  LinearIssueContextResult,
  LinearIssueSummary
} from '../../shared/linear-agent-access'
import { collectInlineMedia } from './issue-context'

function summary(overrides: Partial<LinearIssueSummary>): LinearIssueSummary {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Issue',
    url: 'https://linear.app/acme/issue/ENG-1',
    labels: [],
    ...overrides
  }
}

function comment(overrides: Partial<LinearIssueCommentNode>): LinearIssueCommentNode {
  return { id: 'comment-1', body: '', bodyTruncated: false, ...overrides }
}

function resultWith(overrides: Partial<LinearIssueContextResult>): LinearIssueContextResult {
  return {
    issue: summary({}),
    meta: {
      requested: {
        current: false,
        include: {
          comments: true,
          children: true,
          attachments: false,
          relations: false,
          activity: false
        },
        depth: 3
      },
      resolved: {
        id: 'issue-1',
        identifier: 'ENG-1',
        workspaceId: 'workspace-1',
        workspaceName: 'Acme'
      },
      partial: false,
      includeErrors: [],
      sections: {}
    },
    ...overrides
  }
}

describe('collectInlineMedia', () => {
  it('collects media from the description, comments, and nested children', () => {
    const nestedChild: LinearIssueChildNode = summary({
      id: 'child-2',
      identifier: 'ENG-3',
      description: '![nested](https://uploads.linear.app/w/file/nested?sig=3)'
    })
    const child: LinearIssueChildNode = {
      ...summary({
        id: 'child-1',
        identifier: 'ENG-2',
        description: '![child](https://uploads.linear.app/w/file/child?sig=2)'
      }),
      children: [nestedChild]
    }
    const result = resultWith({
      issue: summary({
        description: '![desc](https://uploads.linear.app/w/file/desc?sig=1)'
      }),
      comments: [
        comment({ id: 'comment-1', body: '![c](https://uploads.linear.app/w/file/comment?sig=4)' })
      ],
      children: [child]
    })

    const media = collectInlineMedia(result)

    expect(media?.map((item) => ({ source: item.source, sourceId: item.sourceId }))).toEqual([
      { source: 'description', sourceId: undefined },
      { source: 'comment', sourceId: 'comment-1' },
      { source: 'child-description', sourceId: 'child-1' },
      { source: 'child-description', sourceId: 'child-2' }
    ])
    expect(media?.every((item) => item.linearUpload)).toBe(true)
  })

  it('returns undefined when no inline media is present', () => {
    const result = resultWith({
      issue: summary({ description: 'No media here.' }),
      comments: [comment({ body: 'plain text' })]
    })

    expect(collectInlineMedia(result)).toBeUndefined()
  })
})
