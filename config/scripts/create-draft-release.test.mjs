import { describe, expect, it, vi } from 'vitest'
import {
  createDraftRelease,
  latestPreviousPublishedDesktopReleaseTag,
  parseDesktopReleaseTag,
  truncateReleaseBody
} from './create-draft-release.mjs'

function release(tag, options = {}) {
  return {
    draft: false,
    tag_name: tag,
    ...options
  }
}

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

describe('parseDesktopReleaseTag', () => {
  it('parses stable and rc desktop release tags only', () => {
    expect(parseDesktopReleaseTag('v1.4.36')).toMatchObject({
      tag: 'v1.4.36',
      major: 1,
      minor: 4,
      patch: 36,
      rc: null
    })
    expect(parseDesktopReleaseTag('v1.4.36-rc.2')).toMatchObject({
      tag: 'v1.4.36-rc.2',
      major: 1,
      minor: 4,
      patch: 36,
      rc: 2
    })
    expect(parseDesktopReleaseTag('mobile-v0.0.12')).toBeNull()
  })
})

describe('latestPreviousPublishedDesktopReleaseTag', () => {
  it('bounds stable notes to the previous stable release when rcs exist', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.35'), release('v1.4.36-rc.0'), release('v1.4.36')],
        'v1.4.36'
      )
    ).toBe('v1.4.35')
  })

  it('does not collapse a stable changelog to its rc-to-stable version bump', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [
          release('v1.4.120'),
          release('v1.4.121-rc.0'),
          release('v1.4.121-rc.6'),
          release('v1.4.121')
        ],
        'v1.4.121'
      )
    ).toBe('v1.4.120')
  })

  it('bounds the first rc notes to the previous stable release', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.35'), release('v1.4.36-rc.0'), release('mobile-v0.0.12')],
        'v1.4.36-rc.0'
      )
    ).toBe('v1.4.35')
  })

  it('bounds later rc notes to the prior rc', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.36-rc.0'), release('v1.4.36-rc.1')],
        'v1.4.36-rc.1'
      )
    ).toBe('v1.4.36-rc.0')
  })

  it('ignores draft releases as public changelog boundaries', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.35'), release('v1.4.36-rc.0', { draft: true }), release('v1.4.36-rc.1')],
        'v1.4.36-rc.1'
      )
    ).toBe('v1.4.35')
  })

  it('returns empty string for the first desktop release when no earlier tag exists', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.36'), release('mobile-v0.0.12')],
        'v1.4.36'
      )
    ).toBe('')
    expect(latestPreviousPublishedDesktopReleaseTag([], 'v1.4.36')).toBe('')
  })

  it('returns empty string when the current tag is not a desktop release tag', () => {
    expect(
      latestPreviousPublishedDesktopReleaseTag(
        [release('v1.4.35'), release('v1.4.36')],
        'mobile-v0.0.12'
      )
    ).toBe('')
  })
})

describe('createDraftRelease', () => {
  it('creates a draft release with bounded generated notes', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([release('v1.4.35'), release('v1.4.36')]))
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
      'https://api.github.com/repos/stablyai/orca/releases?per_page=100&page=1',
      expect.any(Object)
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/stablyai/orca/releases/generate-notes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          tag_name: 'v1.4.36',
          target_commitish: 'v1.4.36',
          previous_tag_name: 'v1.4.35'
        })
      })
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/repos/stablyai/orca/releases',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String)
      })
    )

    const createBody = JSON.parse(fetchImpl.mock.calls[2][1].body)
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
      .mockResolvedValueOnce(jsonResponse([release('v1.4.36'), release('v1.4.36-rc.1')]))
      .mockResolvedValueOnce(jsonResponse({ name: 'v1.4.36-rc.1', body: 'notes' }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.4.36-rc.1', draft: true }))

    await createDraftRelease({
      repo: 'stablyai/orca',
      tag: 'v1.4.36-rc.1',
      token: 'token',
      fetchImpl,
      log: vi.fn()
    })

    const createBody = JSON.parse(fetchImpl.mock.calls[2][1].body)
    expect(createBody.prerelease).toBe(true)
  })

  it('omits previous_tag_name for the first desktop release so notes fall back to the GitHub default', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([release('v1.4.36'), release('mobile-v0.0.12')]))
      .mockResolvedValueOnce(jsonResponse({ name: 'v1.4.36', body: 'notes' }))
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.4.36', draft: true }))

    await createDraftRelease({
      repo: 'stablyai/orca',
      tag: 'v1.4.36',
      token: 'token',
      fetchImpl,
      log: vi.fn()
    })

    const generateNotesBody = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(generateNotesBody).toEqual({ tag_name: 'v1.4.36', target_commitish: 'v1.4.36' })
    expect(generateNotesBody).not.toHaveProperty('previous_tag_name')
  })

  it('paginates through every release page before choosing the previous release', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => release(`mobile-v0.0.${index}`))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(firstPage))
      .mockResolvedValueOnce(jsonResponse([release('v1.4.35')]))
      .mockResolvedValueOnce(jsonResponse({ name: 'v1.4.36', body: 'notes' }))
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
      'https://api.github.com/repos/stablyai/orca/releases?per_page=100&page=1',
      expect.any(Object)
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/repos/stablyai/orca/releases?per_page=100&page=2',
      expect.any(Object)
    )
    const generateNotesBody = JSON.parse(fetchImpl.mock.calls[2][1].body)
    expect(generateNotesBody.previous_tag_name).toBe('v1.4.35')
  })
})
