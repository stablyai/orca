import { expect, it } from 'vitest'
import { mapBitbucketPullRequest } from './pull-request-mappers'

it('maps an open Bitbucket pull request with draft set to draft, keeping terminal states', () => {
  const raw = {
    id: 1,
    title: 'Draft change',
    state: 'OPEN',
    draft: true,
    links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } }
  }
  expect(mapBitbucketPullRequest(raw, 'neutral')?.state).toBe('draft')
  expect(mapBitbucketPullRequest({ ...raw, state: 'MERGED' }, 'neutral')?.state).toBe('merged')
})
