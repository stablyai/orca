import { describe, expect, it, vi } from 'vitest'
import { enforceReleasePolicy, restoreLatestStable } from './release-policy.mjs'

const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const repoRef = { owner: 'stablyai', repo: 'orca' }

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 })
}

// tags: { [tag]: { tagger, subject } } for annotated tags; missing tags 404.
function createGithub({ releases = [], tags = {} } = {}) {
  const rest = {
    repos: {
      listReleases: vi.fn(),
      updateRelease: vi.fn(async () => ({ data: {} })),
      deleteRelease: vi.fn(async () => ({ data: {} }))
    },
    git: {
      getRef: vi.fn(async ({ ref }) => {
        const tag = ref.replace(/^tags\//, '')
        if (!tags[tag]) {
          throw notFound()
        }
        return { data: { object: { type: 'tag', sha: `tag-${tag}` } } }
      }),
      getTag: vi.fn(async ({ tag_sha }) => {
        const tag = tag_sha.replace(/^tag-/, '')
        return {
          data: {
            tagger: { email: tags[tag].tagger ?? BOT_EMAIL },
            object: { type: 'commit', sha: `commit-${tag}` }
          }
        }
      }),
      getCommit: vi.fn(async ({ commit_sha }) => {
        const tag = commit_sha.replace(/^commit-/, '')
        return { data: { message: `${tags[tag].subject ?? `release: ${tag}`}\n` } }
      }),
      deleteRef: vi.fn(async () => ({ data: {} }))
    }
  }
  return { rest, paginate: vi.fn(async () => releases) }
}

function release(tag, author, overrides = {}) {
  return {
    id: Number(tag.replace(/\D/g, '')),
    tag_name: tag,
    author: { login: author },
    draft: false,
    prerelease: false,
    ...overrides
  }
}

function run(github, payloadRelease, action) {
  const core = { warning: vi.fn() }
  const context = { payload: { release: payloadRelease, action }, repo: repoRef }
  return enforceReleasePolicy({ github, context, core }).then(() => core)
}

describe('release policy', () => {
  it('keeps a pipeline-cut release whose draft a person created', async () => {
    const r216 = release('v1.4.216', 'Jinwoo-H')
    const github = createGithub({
      releases: [r216, release('v1.4.214', 'github-actions[bot]')],
      tags: { 'v1.4.216': {}, 'v1.4.214': {} }
    })

    await run(github, r216, 'edited')

    expect(github.rest.repos.deleteRelease).not.toHaveBeenCalled()
    expect(github.rest.git.deleteRef).not.toHaveBeenCalled()
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith({
      ...repoRef,
      release_id: r216.id,
      make_latest: 'true'
    })
  })

  it('never deletes an unauthorized release on edit', async () => {
    const qa = release('v1.4.300', 'someone')
    const github = createGithub({ releases: [qa] })

    const core = await run(github, qa, 'edited')

    expect(github.rest.repos.deleteRelease).not.toHaveBeenCalled()
    expect(github.rest.git.deleteRef).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('left as-is'))
  })

  it('deletes a published release whose tag was not cut by the pipeline', async () => {
    const qa = release('v1.4.300', 'someone')
    const github = createGithub({
      releases: [qa, release('v1.4.215', 'nwparker')],
      tags: { 'v1.4.300': { tagger: 'someone@example.com' }, 'v1.4.215': {} }
    })

    await run(github, qa, 'published')

    expect(github.rest.repos.deleteRelease).toHaveBeenCalledWith({ ...repoRef, release_id: qa.id })
    expect(github.rest.git.deleteRef).toHaveBeenCalledWith({ ...repoRef, ref: 'tags/v1.4.300' })
  })

  it('rejects a bot-tagged tag whose commit is not a release commit', async () => {
    const qa = release('v1.4.300', 'someone')
    const github = createGithub({ tags: { 'v1.4.300': { subject: 'fix: something' } } })

    await run(github, qa, 'published')

    expect(github.rest.repos.deleteRelease).toHaveBeenCalled()
  })

  it('accepts scheduled RC release commits', async () => {
    const rc = release('v1.4.217-rc.1', 'someone', { prerelease: true })
    const github = createGithub({
      tags: { 'v1.4.217-rc.1': { subject: 'release: v1.4.217-rc.1 [rc-slot:2026-09-28-15]' } }
    })

    await run(github, rc, 'published')

    expect(github.rest.repos.deleteRelease).not.toHaveBeenCalled()
  })

  it('restores Latest to the highest pipeline-cut stable, not only bot-authored ones', async () => {
    const github = createGithub({
      releases: [
        release('v1.4.214', 'github-actions[bot]'),
        release('v1.4.215', 'nwparker'),
        release('v1.4.216-rc.0', 'github-actions[bot]', { prerelease: true })
      ],
      tags: { 'v1.4.214': {}, 'v1.4.215': {} }
    })

    await expect(restoreLatestStable(github, repoRef)).resolves.toBe('v1.4.215')
    expect(github.rest.repos.updateRelease).toHaveBeenCalledTimes(1)
  })

  it('compares versions numerically when picking Latest', async () => {
    const github = createGithub({
      releases: [
        release('v1.4.99', 'github-actions[bot]'),
        release('v1.4.100', 'github-actions[bot]')
      ]
    })

    await expect(restoreLatestStable(github, repoRef)).resolves.toBe('v1.4.100')
  })

  it('keeps a bot-published agent state rules release as a prerelease, off Latest', async () => {
    const rules = release('agent-state-rules-engine-1-next', 'github-actions[bot]')
    const stable = release('v1.4.214', 'github-actions[bot]')
    const github = createGithub({
      releases: [rules, stable],
      tags: { 'v1.4.214': {} }
    })

    await run(github, rules, 'published')

    expect(github.rest.repos.deleteRelease).not.toHaveBeenCalled()
    expect(github.rest.git.deleteRef).not.toHaveBeenCalled()
    expect(github.rest.repos.updateRelease).toHaveBeenCalledWith({
      ...repoRef,
      release_id: rules.id,
      prerelease: true,
      make_latest: 'false'
    })
    expect(github.rest.repos.updateRelease).toHaveBeenLastCalledWith({
      ...repoRef,
      release_id: stable.id,
      make_latest: 'true'
    })
  })

  it('deletes an agent state rules release a person published', async () => {
    const rules = release('agent-state-rules-engine-1-stable', 'someone', { prerelease: true })
    const github = createGithub({ releases: [rules] })

    await run(github, rules, 'published')

    expect(github.rest.repos.deleteRelease).toHaveBeenCalledWith({
      ...repoRef,
      release_id: rules.id
    })
  })
})
