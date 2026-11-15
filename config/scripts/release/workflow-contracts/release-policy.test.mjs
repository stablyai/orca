import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
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
  beforeEach(() => vi.stubEnv('RELEASE_APP_BOT_ID', '356766123'))
  afterEach(() => vi.unstubAllEnvs())

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

  it('deletes an App-login release when the variable is missing, and warns', async () => {
    vi.stubEnv('RELEASE_APP_BOT_ID', '')
    const rest = await publish(appBot)
    expect(rest.repos.deleteRelease).toHaveBeenCalled()
  })

  it('matches the App bot only by its configured numeric user ID', () => {
    expect(isReleaseAppBot(appBot, '356766123')).toBe(true)
    expect(isReleaseAppBot({ ...appBot, login: 'renamed[bot]' }, '356766123')).toBe(true)
    expect(isReleaseAppBot({ ...appBot, id: 999 }, '356766123')).toBe(false)
    expect(isReleaseAppBot(appBot, '')).toBe(false)
    expect(isReleaseAppBot(appBot, null)).toBe(false)
    expect(isReleaseAppBot(appBot, 'orca-release[bot]')).toBe(false)
    expect(isReleaseAppBot(appBot, ' 356766123 ')).toBe(false)
    expect(isReleaseAppBot(appBot, '356766123\n')).toBe(false)
    expect(isReleaseAppBot({ ...appBot, type: 'User' }, '356766123')).toBe(false)
  })
})

describe('restoreLatestStable', () => {
  beforeEach(() => vi.stubEnv('RELEASE_APP_BOT_ID', '356766123'))
  afterEach(() => vi.unstubAllEnvs())
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

describe.skipIf(process.platform === 'win32')('docs release gate', () => {
  const docs = parse(readFileSync('.github/workflows/docs.yml', 'utf8'))
  const gate = docs.jobs.release_gate.steps.find((step) => step.id === 'validate').run
  // Any later API call fails at once; these cases only differ at the author check.
  const stubs = mkdtempSync(join(tmpdir(), 'docs-gate-'))
  for (const name of ['gh', 'sleep']) {
    writeFileSync(join(stubs, name), '#!/bin/sh\nexit 1\n')
    chmodSync(join(stubs, name), 0o755)
  }
  const run = (authorId, botId) =>
    runProcessSync({
      program: 'bash',
      args: ['-c', gate],
      env: {
        PATH: `${stubs}:${process.env.PATH}`,
        GITHUB_OUTPUT: '/dev/null',
        EVENT_NAME: 'release',
        INPUT_TAG: '',
        RELEASE_PRERELEASE: 'false',
        RELEASE_DRAFT: 'false',
        DEFAULT_BRANCH: 'main',
        WORKFLOW_REF: 'refs/tags/v1.4.260',
        RELEASE_TAG: 'v1.4.260',
        RELEASE_AUTHOR: 'orca-release[bot]',
        RELEASE_AUTHOR_ID: authorId,
        RELEASE_AUTHOR_TYPE: 'Bot',
        RELEASE_APP_BOT_ID: botId,
        GH_TOKEN: ''
      }
    }).stdout

  it.each([
    ['the configured ID', '356766123', '356766123', true],
    ['the App login with another ID', '999', '356766123', false],
    ['a missing variable', '356766123', '', false],
    ['a whitespace-padded variable', '356766123', ' 356766123 ', false]
  ])('leaves the deploy to release-cut only for %s', (_name, authorId, botId, skipped) => {
    expect(run(authorId, botId).includes('published by the release App')).toBe(skipped)
  })
})
