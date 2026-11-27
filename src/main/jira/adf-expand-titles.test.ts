import { expect, it } from 'vitest'
import { mapJiraIssue } from './jira-issue-mapping'

it('keeps expansion titles with their bodies, including an expansion inside a table', () => {
  const issue = mapJiraIssue(
    {
      id: 'site',
      siteUrl: 'https://example.atlassian.net',
      email: 'reader@example.test',
      displayName: 'Example',
      accountId: 'reader'
    },
    {
      key: 'OPS-2',
      fields: {
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'expand',
              attrs: { title: 'Linux only' },
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Reproduce the failure.' }]
                }
              ]
            },
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [
                        {
                          type: 'nestedExpand',
                          attrs: { title: 'Expected result' },
                          content: [
                            {
                              type: 'paragraph',
                              content: [{ type: 'text', text: 'Keep the current session.' }]
                            }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    }
  )
  expect(issue.description).toBe(
    '**Linux only**\n\nReproduce the failure.\n\n**Expected result**\n\nKeep the current session.'
  )
})
