import { describe, expect, it } from 'vitest'
import { enforceReleasePolicy, restoreLatestStable } from './release-policy.mjs'

const repo = { owner: 'stablyai', repo: 'orca' }
const published = {
  id: 258,
  tag_name: 'v1.4.258',
  draft: false,
  prerelease: false,
  author: { login: 'release-owner', id: 12345 }
}

function fixture(releases, { annotated = false } = {}) {
  const state = structuredClone(releases)
  let latest = null
  const refs = new Set(releases.map((release) => `tags/${release.tag_name}`))
  const github = {
    paginate: async () => state,
    rest: {
      repos: {
        listReleases() {},
        updateRelease: async ({ release_id, make_latest, ...patch }) => {
          Object.assign(
            state.find((release) => release.id === release_id),
            patch
          )
          if (make_latest === 'true') {
            latest = release_id
          }
        },
        deleteRelease: async ({ release_id }) => {
          state.splice(
            state.findIndex((release) => release.id === release_id),
            1
          )
        }
      },
      git: {
        getRef: async () => ({
          data: { object: { type: annotated ? 'tag' : 'commit', sha: 'tag' } }
        }),
        getTag: async () => ({
          data: {
            tagger: { email: '41898282+github-actions[bot]@users.noreply.github.com' },
            object: { type: 'commit', sha: 'commit' }
          }
        }),
        getCommit: async () => ({ data: { message: 'release: v1.4.258' } }),
        deleteRef: async ({ ref }) => {
          refs.delete(ref)
        }
      }
    }
  }
  return {
    github,
    state,
    refs,
    get latest() {
      return latest
    }
  }
}

async function enforce(f, release = published, releaseCreatorId = '12345') {
  await enforceReleasePolicy({
    github: f.github,
    context: { repo, payload: { action: 'published', release } },
    core: { warning() {} },
    releaseCreatorId
  })
}

describe('configured release creator policy', () => {
  it('retains a lightweight configured release and selects it as Latest', async () => {
    const f = fixture([published])
    await enforce(f)
    expect(f.state.map((release) => release.tag_name)).toEqual(['v1.4.258'])
    expect(f.refs.has('tags/v1.4.258')).toBe(true)
    expect(f.latest).toBe(258)
    expect(await restoreLatestStable(f.github, repo, '12345')).toBe('v1.4.258')
  })

  it('finds the configured stable after an unauthorized publication', async () => {
    const unauthorized = {
      ...published,
      id: 259,
      tag_name: 'v1.4.259',
      author: { login: 'other-owner', id: 67890 }
    }
    const f = fixture([published, unauthorized])
    await enforce(f, unauthorized)
    expect(f.state.map((release) => release.tag_name)).toEqual(['v1.4.258'])
    expect(f.refs.has('tags/v1.4.259')).toBe(false)
    expect(f.latest).toBe(258)
  })

  it.each(['', '12345oops', '67890'])(
    'does not grant creator authority with configured ID %s',
    async (configured) => {
      const f = fixture([published])
      await enforce(f, published, configured)
      expect(f.state).toEqual([])
      expect(f.refs.has('tags/v1.4.258')).toBe(false)
    }
  )

  it('retains existing bot and human-created pipeline-tag authorization', async () => {
    const bot = { ...published, author: { login: 'github-actions[bot]' } }
    const f = fixture([bot])
    await enforce(f, bot, '')
    expect(f.latest).toBe(258)
    const human = fixture([published], { annotated: true })
    await enforce(human, published, '')
    expect(human.state.map((release) => release.tag_name)).toEqual(['v1.4.258'])
    expect(human.latest).toBe(258)
  })

  it('does not extend the dedicated identity to mobile tags', async () => {
    const mobile = { ...published, tag_name: 'mobile-v1.4.258', prerelease: true }
    const f = fixture([mobile])
    await enforce(f, mobile)
    expect(f.state).toEqual([])
  })
})
