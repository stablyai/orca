import { expect, it } from 'vitest'
import { mapBitbucketPullRequest } from './pull-request-mappers'

it('preserves Bitbucket draft state while terminal states take precedence', () => {
  const raw = {
    id: 1,
    title: 'Draft change',
    state: 'OPEN',
    draft: true,
    links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/1' } }
  }
  expect(mapBitbucketPullRequest(raw, 'neutral')?.state).toBe('draft')
  expect(mapBitbucketPullRequest({ ...raw, state: 'MERGED' }, 'neutral')?.state).toBe('merged')
  expect(mapBitbucketPullRequest({ ...raw, state: 'DECLINED' }, 'neutral')?.state).toBe('closed')
  expect(mapBitbucketPullRequest({ ...raw, draft: false }, 'neutral')?.state).toBe('open')
})
