import { describe, expect, it, vi } from 'vitest'
import { enforceReleasePolicy, isReleaseAppBot, restoreLatestStable } from './release-policy.mjs'

const appBot = { login: 'orca-release[bot]', id: 356766123, type: 'Bot' }

// v1.4.259 shape: the tag was pushed and tagged by a person, so only the release author can authorize it.
function fakeGithub() {
  const humanTag = { object: { type: 'tag', sha: 't'.repeat(40) } }
  return {
    paginate: vi.fn(async () => []),
    rest: {
      repos: { listReleases: vi.fn(), updateRelease: vi.fn(), deleteRelease: vi.fn() },
      git: {
        getRef: vi.fn(async () => ({ data: humanTag })),
        getTag: vi.fn(async () => ({
          data: { tagger: { email: 'person@example.com' }, object: { type: 'commit', sha: 'c' } }
        })),
        getCommit: vi.fn(),
        deleteRef: vi.fn()
      }
    }
  }
}

async function publish(author) {
  const github = fakeGithub()
  const core = { warning: vi.fn() }
  const release = { id: 1, tag_name: 'v1.4.259', prerelease: false, author }
  await enforceReleasePolicy({
    github,
    context: { payload: { action: 'published', release }, repo: { owner: 'o', repo: 'r' } },
    core
  })
  return github.rest
}

describe('release policy release authors', () => {
  it('keeps a human-tagged release the release App published', async () => {
    const rest = await publish(appBot)
    expect(rest.repos.deleteRelease).not.toHaveBeenCalled()
    expect(rest.git.deleteRef).not.toHaveBeenCalled()
  })

  it('still deletes a human-tagged release published by anyone else', async () => {
    const rest = await publish({ login: 'someone', id: 5, type: 'User' })
    expect(rest.repos.deleteRelease).toHaveBeenCalledWith({ owner: 'o', repo: 'r', release_id: 1 })
    expect(rest.git.deleteRef).toHaveBeenCalledWith({ owner: 'o', repo: 'r', ref: 'tags/v1.4.259' })
  })

  it('matches the App bot by its configured user ID after a rename, and never a User', () => {
    expect(isReleaseAppBot({ ...appBot, login: 'renamed[bot]' }, '356766123')).toBe(true)
    expect(isReleaseAppBot({ ...appBot, login: 'renamed[bot]' }, '')).toBe(false)
    expect(isReleaseAppBot({ ...appBot, type: 'User' }, '356766123')).toBe(false)
  })
})

describe('restoreLatestStable', () => {
  const stable = { id: 7, tag_name: 'v1.4.260', draft: false, prerelease: false, author: appBot }
  function github({ latestId, updateError }) {
    return {
      paginate: vi.fn(async () => [stable]),
      rest: {
        repos: {
          listReleases: vi.fn(),
          getLatestRelease: vi.fn(async () => ({ data: { id: latestId } })),
          updateRelease: vi.fn(async () => {
            if (updateError) {
              throw updateError
            }
          })
        }
      }
    }
  }

  it('leaves an already-correct Latest untouched', async () => {
    const gh = github({ latestId: 7 })
    await expect(restoreLatestStable(gh, { owner: 'o', repo: 'r' })).resolves.toBe('v1.4.260')
    expect(gh.rest.repos.updateRelease).not.toHaveBeenCalled()
  })

  it('reports a refused Latest update instead of failing the policy', async () => {
    const gh = github({
      latestId: 1,
      updateError: Object.assign(new Error('nope'), { status: 403 })
    })
    const core = { error: vi.fn() }
    await expect(restoreLatestStable(gh, { owner: 'o', repo: 'r' }, core)).resolves.toBeNull()
    expect(gh.rest.repos.updateRelease).toHaveBeenCalledWith(
      expect.objectContaining({ tag_name: 'v1.4.260', make_latest: 'true' })
    )
    expect(core.error).toHaveBeenCalledWith(expect.stringContaining('403'))
  })
})
