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

describe.each(['GraphQL', 'REST'] as const)('%s review summaries', (source) => {
  it('omits empty and HTML-comment-only reviews while preserving visible bodies', () => {
    const bodies = [null, '', ' \n\t ', metadataOnlyBody, ...visibleBodies]
    const comments = bodies.map((body, id) => ({
      id: `PRR_${id}`,
      databaseId: id,
      author: { login: 'coderabbitai', avatarUrl: '' },
      body,
      createdAt: '2026-11-02T08:18:39Z',
      url: `https://github.com/acme/widgets/pull/7#pullrequestreview-${id}`
    }))

    const reviews =
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
                html_url: comment.url
              }))
            ),
            true
          )

    expect(reviews?.map((review) => review.body)).toEqual(visibleBodies)
  })
})
