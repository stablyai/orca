import { describe, expect, it, vi } from 'vitest'
import { createDraftRelease, truncateReleaseBody } from './create-draft-release.mjs'

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body)))
  }
}

describe('truncateReleaseBody', () => {
  it('leaves short release notes unchanged', () => {
    expect(truncateReleaseBody('short notes', 120_000)).toBe('short notes')
  })

  it('caps long release notes and appends an explanation', () => {
    const body = truncateReleaseBody('a'.repeat(130_000), 1_000)

    expect(body).toHaveLength(1_000)
    expect(body).toContain('Release notes were truncated')
  })
})

describe('createDraftRelease', () => {
  it('creates a draft release with bounded generated notes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'v1.4.36', body: 'a'.repeat(130_000) }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.4.36', draft: true }))

    await createDraftRelease({
      repo: 'stablyai/orca',
      tag: 'v1.4.36',
      token: 'token',
      fetchImpl,
      log: vi.fn()
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/stablyai/orca/releases/generate-notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          tag_name: 'v1.4.36',
          target_commitish: 'v1.4.36'
        })
      })
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/stablyai/orca/releases',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String)
      })
    )

    const createBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(createBody).toMatchObject({
      tag_name: 'v1.4.36',
      name: 'v1.4.36',
      draft: true,
      prerelease: false
    })
    expect(createBody.body).toHaveLength(120_000)
    expect(createBody.body).toContain('Release notes were truncated')
  })

  it('marks rc tags as prereleases', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ name: 'v1.4.36-rc.1', body: 'notes' }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.4.36-rc.1', draft: true }))

    await createDraftRelease({
      repo: 'stablyai/orca',
      tag: 'v1.4.36-rc.1',
      token: 'token',
      fetchImpl,
      log: vi.fn()
    })

    const createBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(createBody.prerelease).toBe(true)
  })
})
