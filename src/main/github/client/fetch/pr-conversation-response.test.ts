import { describe, expect, it } from 'vitest'
import { parsePRConversationResponse, parseRestPRComments } from './pr-conversation-response'

const metadataOnlyBody = `<!-- coderabbit-ai-generated:v1 -->

<!-- This is an auto-generated comment by CodeRabbit for review status -->

<!-- coderabbit-review-publication v1 publication=review-id attempt=attempt-id batch=1/1 -->`

const visibleBodies = [
  `${metadataOnlyBody}\n\nFound an issue in the focus handler.`,
  '<details><summary>Review details</summary>Needs a fix.</details>',
  '![Review status](https://example.com/status.svg)',
  '```html\n<!-- example HTML comment -->\n```',
  '    <!-- Keep this comment in the template -->',
  '\t<!-- Keep tab-indented code -->',
  `${metadataOnlyBody}\n\n    <!-- Indented example -->`,
  '`<!-- inline example -->`'
]

type ReviewNode = {
  id: string
  databaseId: number
  author: { login: string; avatarUrl: string }
  body: string | null
  createdAt: string
  url: string
  state?: string
}

describe.each(['GraphQL', 'REST'] as const)('%s review summaries', (source) => {
  const parseReviews = (comments: ReviewNode[]) =>
    source === 'GraphQL'
      ? parsePRConversationResponse(
          JSON.stringify({
            data: { repository: { pullRequest: { reviews: { nodes: comments } } } }
          })
        ).reviewSummaries
      : parseRestPRComments(
          JSON.stringify(
            comments.map((comment) => ({
              id: comment.databaseId,
              user: { login: comment.author.login, avatar_url: '' },
              body: comment.body,
              submitted_at: comment.createdAt,
              state: comment.state,
              html_url: comment.url
            }))
          ),
          true,
          null
        )

  it('omits empty and HTML-comment-only reviews while preserving visible bodies', () => {
    const bodies = [
      null,
      '',
      ' \n\t ',
      metadataOnlyBody,
      '**<!-- metadata -->**',
      '[<!-- metadata -->](https://example.com)',
      ...visibleBodies
    ]
    const comments = bodies.map((body, id) => ({
      id: `PRR_${id}`,
      databaseId: id,
      author: { login: 'coderabbitai', avatarUrl: '' },
      body,
      createdAt: '2026-11-02T08:18:39Z',
      url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`
    }))

    expect(parseReviews(comments)?.map((review) => review.body)).toEqual(visibleBodies)
  })

  it('keeps bodyless approvals and change requests, blanking metadata-only bodies', () => {
    const states = [
      'APPROVED',
      'CHANGES_REQUESTED',
      'COMMENTED',
      'DISMISSED',
      'PENDING',
      'APPROVED'
    ]
    const comments = states.map((state, id) => ({
      id: `PRR_${id}`,
      databaseId: id,
      author: { login: 'alice', avatarUrl: '' },
      body: id === 5 ? metadataOnlyBody : '',
      createdAt: '2026-11-02T08:18:39Z',
      url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`,
      state
    }))

    expect(
      parseReviews(comments)?.map((review) => [review.id, review.reviewState, review.body])
    ).toEqual([
      [0, 'APPROVED', ''],
      [1, 'CHANGES_REQUESTED', ''],
      [5, 'APPROVED', '']
    ])
  })
})

it('marks only the conversation comments GitHub says the viewer wrote', () => {
  const node = (databaseId: number, viewerDidAuthor: boolean) => ({
    id: `IC_${databaseId}`,
    databaseId,
    author: { login: viewerDidAuthor ? 'me' : 'alice', avatarUrl: '' },
    body: 'LGTM',
    createdAt: '2026-11-07T08:00:00Z',
    url: `https://github.com/acme/widgets/pull/7#issuecomment-${databaseId}`,
    viewerDidAuthor
  })
  const { issueComments } = parsePRConversationResponse(
    JSON.stringify({
      data: {
        repository: { pullRequest: { comments: { nodes: [node(1, false), node(2, true)] } } }
      }
    })
  )

  expect(issueComments?.map((comment) => comment.viewerDidAuthor)).toEqual([undefined, true])
})
