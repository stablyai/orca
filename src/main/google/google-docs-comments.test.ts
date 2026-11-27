import { expect, it } from 'vitest'
import type { GoogleApi } from './google-api-client'
import { openComments } from './google-docs-comments'
import { readDoc } from './google-docs'

const PAGES: Record<string, { comments: unknown[]; nextPageToken?: string }> = {
  '': { comments: [{ content: 'Already addressed', resolved: true }], nextPageToken: 'empty' },
  empty: { comments: [], nextPageToken: 'open' },
  open: {
    comments: [
      { content: 'Remove me', deleted: true },
      { content: 'Please check the total', author: { displayName: 'Reviewer' } }
    ]
  }
}

const unexpected = () => Promise.reject(new Error('Unexpected Google call'))

// Like Drive, answers only the fields the request's `fields` mask names.
const drive: GoogleApi = {
  email: 'reader@example.com',
  get: async (_service, href, read) => {
    const url = new URL(href)
    const page = PAGES[url.searchParams.get('pageToken') ?? '']
    if (!page) {
      throw new Error(`Unexpected comment page: ${href}`)
    }
    const { nextPageToken: _, ...comments } = page
    const answer = read(
      url.searchParams.get('fields')?.split(',').includes('nextPageToken') ? page : comments
    )
    if (answer === null) {
      throw new Error('Unreadable comment page')
    }
    return answer
  },
  find: unexpected,
  send: unexpected,
  bytes: unexpected
}

it('reads open comments from every page, past resolved and empty ones', async () => {
  await expect(openComments(drive, 'document-1234567890')).resolves.toEqual({
    comments: [{ author: 'Reviewer', text: 'Please check the total', replies: [] }],
    more: false
  })
})

it('stops at the page cap, even when Drive repeats a page token', async () => {
  let calls = 0
  const endless: GoogleApi = {
    ...drive,
    get: async (_service, _href, read) => {
      calls++
      const answer = read({ comments: [{ content: 'Open' }], nextPageToken: 'again' })
      if (answer === null) {
        throw new Error('Unreadable comment page')
      }
      return answer
    }
  }
  const { comments, more } = await openComments(endless, 'document-1234567890')
  expect({ calls, read: comments.length, more }).toEqual({ calls: 20, read: 20, more: true })
})

it('keeps the comments already read when a later comment page fails', async () => {
  const flaky: GoogleApi = {
    ...drive,
    get: async (_service, href, read) => {
      if (new URL(href).searchParams.has('pageToken')) {
        throw new Error('Google timed out')
      }
      const answer = read({
        comments: [{ content: 'Please check the total', author: { displayName: 'Reviewer' } }],
        nextPageToken: 'next'
      })
      if (answer === null) {
        throw new Error('Unreadable comment page')
      }
      return answer
    }
  }
  await expect(openComments(flaky, 'document-1234567890')).resolves.toEqual({
    comments: [{ author: 'Reviewer', text: 'Please check the total', replies: [] }],
    more: true
  })
})

it('reads one comment page for a later page of the doc, and says the count is a lower bound', async () => {
  const calls: string[] = []
  const api: GoogleApi = {
    ...drive,
    find: async (_service, _href, read) => read({ documentId: 'document-1234567890' }),
    get: async (service, href, read) => {
      calls.push(href)
      return drive.get(service, href, read)
    }
  }
  const view = await readDoc(api, { ref: 'document-1234567890', offset: 1 })
  expect({ calls: calls.length, open: view.openComments, more: view.moreComments }).toEqual({
    calls: 1,
    open: 0,
    more: true
  })
})
