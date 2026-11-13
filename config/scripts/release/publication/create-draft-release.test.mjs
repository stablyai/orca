import { describe, expect, it } from 'vitest'
import { createDraftRelease } from './create-draft-release.mjs'

const source = 'a'.repeat(40)
const checkout = 'b'.repeat(40)
const draft = { id: 256, draft: true, tag_name: 'v1.4.256', body: 'original notes' }

function fixture(options = {}) {
  const writes = []
  let wrote = false
  const response = (body, status = 200) => ({
    ok: status === 200,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    json: async () => body,
    text: async () => JSON.stringify(body)
  })
  const fetchImpl = async (url, request = {}) => {
    const route = url.replace('https://api.github.com/repos/test/repo', '')
    const method = request.method ?? 'GET'
    if (route === '/git/ref/tags/v1.4.256') {
      if (options.missing || (wrote && options.deleted)) {
        return response({}, 404)
      }
      return response({
        ref: 'refs/tags/v1.4.256',
        object: {
          type: options.annotated ? 'tag' : 'commit',
          sha: options.annotated ? 'c'.repeat(40) : checkout
        }
      })
    }
    if (route === '/commits/refs/tags/v1.4.256') {
      return response({
        sha: wrote && options.moved ? 'd'.repeat(40) : (options.commit ?? checkout),
        parents: (options.parents ?? [source]).map((sha) => ({ sha }))
      })
    }
    if (route === '') {
      return response({ default_branch: 'main' })
    }
    if (route.startsWith('/releases?')) {
      return response(options.existing ? [draft] : [])
    }
    if (route === '/releases/generate-notes') {
      return response({ body: 'new notes', name: 'release' })
    }
    if (route === '/releases/256' && method === 'GET') {
      return response(wrote ? (options.afterPatch ?? draft) : (options.beforePatch ?? draft))
    }
    if (method === 'POST' || method === 'PATCH') {
      const body = JSON.parse(request.body)
      writes.push({ method, route, body })
      wrote = true
      return response(options.writeResult ?? { ...draft, body: body.body })
    }
    if (route === '/releases') {
      return response(options.visible ?? [draft])
    }
    throw new Error(`Unexpected request ${method} ${route}`)
  }
  return {
    writes,
    run: () =>
      createDraftRelease({
        repo: 'test/repo',
        tag: 'v1.4.256',
        token: 'fixture-token',
        targetCommitish: checkout,
        sourceSha: options.approvedSource ?? source,
        fetchImpl,
        sleep: async () => {},
        log: () => {}
      })
  }
}

describe('release draft source and uploader contract', () => {
  it.each([false, true])(
    'uses existing tag source with default metadata (annotated=%s)',
    async (annotated) => {
      const f = fixture({ annotated })
      await f.run()
      expect(f.writes).toEqual([
        {
          method: 'POST',
          route: '/releases',
          body: {
            tag_name: 'v1.4.256',
            target_commitish: 'main',
            name: 'release',
            body: 'new notes',
            draft: true,
            prerelease: false,
            make_latest: 'false'
          }
        }
      ])
    }
  )

  it.each([
    { missing: true },
    { commit: 'd'.repeat(40) },
    { parents: ['d'.repeat(40)] },
    { parents: [source, 'd'.repeat(40)] }
  ])('refuses an absent, mismatched or unauthorized tag before writing: %j', async (options) => {
    const f = fixture(options)
    await expect(f.run()).rejects.toThrow()
    expect(f.writes).toEqual([])
  })

  it('accepts an approved source that is itself the release commit', async () => {
    const f = fixture({ approvedSource: checkout, parents: [] })
    await f.run()
    expect(f.writes[0].body.tag_name).toBe('v1.4.256')
  })

  it.each([
    { visible: [{ ...draft, tag_name: '1.4.256' }, draft] },
    { visible: [{ ...draft, id: 999 }] },
    { visible: [{ ...draft, draft: false }] },
    { visible: [] },
    { writeResult: { ...draft, tag_name: 'untagged-test' } },
    { moved: true },
    { deleted: true }
  ])('refuses unsafe upload selection or changed source after writing: %j', async (options) => {
    const f = fixture(options)
    await expect(f.run()).rejects.toThrow()
  })

  it('heals existing-draft metadata and preserves the draft identity', async () => {
    const f = fixture({ existing: true })
    await f.run()
    expect(f.writes).toEqual([
      {
        method: 'PATCH',
        route: '/releases/256',
        body: { body: 'new notes', target_commitish: 'main' }
      }
    ])
  })

  it.each([{ parents: [] }, { moved: true }, { visible: [{ ...draft, id: 999 }] }])(
    'existing-draft recovery cannot bypass source or uploader checks: %j',
    async (options) => {
      const f = fixture({ existing: true, ...options })
      await expect(f.run()).rejects.toThrow()
    }
  )

  it('restores the published body if publication wins the patch race', async () => {
    const f = fixture({
      existing: true,
      writeResult: { ...draft, draft: false, body: 'new notes' },
      afterPatch: { ...draft, draft: false, body: 'new notes' }
    })
    await expect(f.run()).rejects.toThrow('restored its published body')
    expect(f.writes.at(-1)).toEqual({
      method: 'PATCH',
      route: '/releases/256',
      body: { body: 'original notes' }
    })
  })

  it('preserves a newer body when publication and another edit win the patch race', async () => {
    const f = fixture({
      existing: true,
      writeResult: { ...draft, draft: false },
      afterPatch: { ...draft, draft: false, body: 'newer public edit' }
    })
    await expect(f.run()).rejects.toThrow('leaving the newer body')
    expect(f.writes).toHaveLength(1)
  })

  it('leaves a release published during notes generation untouched and refuses success', async () => {
    const f = fixture({ existing: true, beforePatch: { ...draft, draft: false } })
    await expect(f.run()).rejects.toThrow('published while notes were generated')
    expect(f.writes).toEqual([])
  })
})
