import { expect, it } from 'vitest'
import { mapJiraIssue } from './jira-issue-mapping'

const site = {
  id: 'site',
  siteUrl: 'https://example.atlassian.net',
  email: 'reader@example.test',
  displayName: 'Example',
  accountId: 'reader'
}

it('keeps inline calendar dates in an issue description', () => {
  const issue = mapJiraIssue(site, {
    key: 'OPS-1',
    fields: {
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Ship on ' },
              { type: 'date', attrs: { timestamp: '1690344879000' } },
              { type: 'text', text: '.' }
            ]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'date', attrs: { timestamp: '0' } },
              { type: 'text', text: ' / ' },
              { type: 'date', attrs: { timestamp: '-86400000' } }
            ]
          }
        ]
      }
    }
  })
  expect(issue.description).toBe('Ship on 2023-07-26.\n\n1970-01-01 / 1969-12-31')
})
