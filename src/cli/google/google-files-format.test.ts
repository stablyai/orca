import { expect, it } from 'vitest'
import { formatDocsRead } from './google-files-format'

const view = {
  account: 'ada@acme.dev',
  id: 'document-1234567890',
  title: 'Plan',
  link: 'https://docs.google.com/document/d/document-1234567890/edit',
  text: 'Body',
  suggestions: 0,
  comments: [{ author: 'Reviewer', text: 'Check the total', replies: [] }]
}

it('marks a comment count Orca stopped paging as a lower bound', () => {
  expect(formatDocsRead({ ...view, openComments: 1, moreComments: true })).toContain(
    '[Orca: 1+ open comments]'
  )
  const capped = formatDocsRead({ ...view, openComments: 3, moreComments: true })
  expect(capped).toContain('[Orca: 2+ more not shown; they are in the doc]')
  const empty = formatDocsRead({ ...view, comments: [], openComments: 0, moreComments: true })
  expect(empty).toContain('[Orca: 0+ open comments]')
  expect(empty).not.toContain('more not shown')
})
