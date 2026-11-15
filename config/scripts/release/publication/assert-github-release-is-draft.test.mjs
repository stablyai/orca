import { describe, expect, it, vi } from 'vitest'
import { restorePublishedDesktopReleasesToDraft } from './assert-github-release-is-draft.mjs'

describe('restorePublishedDesktopReleasesToDraft', () => {
  it('re-drafts with the release tag so the PATCH cannot untag it', async () => {
    const release = { id: 5, tag_name: 'v1.4.260', draft: false }
    const fetchImpl = vi.fn(async (_url, options = {}) => ({
      ok: true,
      json: async () => (options.method === 'PATCH' ? { ...release, draft: true } : [release])
    }))
    await restorePublishedDesktopReleasesToDraft({
      repo: 'o/r',
      tag: 'v1.4.260',
      token: 't',
      fetchImpl,
      log: () => {}
    })
    const patch = fetchImpl.mock.calls.find(([, options]) => options?.method === 'PATCH')
    expect(JSON.parse(patch[1].body)).toEqual({
      tag_name: 'v1.4.260',
      draft: true,
      make_latest: 'false'
    })
  })
})
