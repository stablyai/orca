import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isReleaseCutDraft,
  isTagBuiltFromCurrentRef,
  publishCompleteDraftReleases,
  verifyDraftReleaseTag
} from './publish-complete-draft-releases.mjs'
import { getRequiredReleaseAssetNames } from './verify-release-required-assets.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

async function withGitRepo(run) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-draft-release-'))
  try {
    git(dir, ['init', '--initial-branch=main'])
    git(dir, ['config', 'user.name', 'Test Bot'])
    git(dir, ['config', 'user.email', 'test@example.com'])
    // Why: global tag.gpgsign turns lightweight fixture tags into annotated ones that need a message.
    git(dir, ['config', 'commit.gpgsign', 'false'])
    git(dir, ['config', 'tag.gpgsign', 'false'])
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function commit(cwd, message) {
  git(cwd, ['commit', '--allow-empty', '-m', message])
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

describe('isTagBuiltFromCurrentRef', () => {
  it('accepts a tag whose release commit is built from the current ref', async () => {
    await withGitRepo((repo) => {
      commit(repo, 'initial')
      const source = git(repo, ['rev-parse', 'HEAD'])
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])
      git(repo, ['checkout', source])

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(true)
    })
  })
})

const APP_BOT = { login: 'orca-release[bot]', id: 356766123, type: 'Bot' }

describe('publishCompleteDraftReleases', () => {
  beforeEach(() => vi.stubEnv('RELEASE_APP_BOT_ID', '356766123'))
  afterEach(() => vi.unstubAllEnvs())

  it('publishes complete release-cut drafts and skips incomplete ones', async () => {
    await withGitRepo(async (repo) => {
      commit(repo, 'release source')
      git(repo, ['tag', 'v1.4.2-rc.7'])
      git(repo, ['tag', 'v1.4.2-rc.8'])
      const releaseSha = git(repo, ['rev-parse', 'HEAD'])
      const releases = [7, 8].map((id) => ({
        id,
        draft: true,
        tag_name: `v1.4.2-rc.${id}`,
        target_commitish: releaseSha,
        created_at: `2026-05-15T0${id}:31:19Z`,
        author: APP_BOT,
        assets: getRequiredReleaseAssetNames(`v1.4.2-rc.${id}`)
          .filter((name) => id === 7 || name !== 'orca-windows-setup.exe')
          .map((name, index) => ({ id: id * 100 + index, name, state: 'uploaded', size: 1 }))
      }))
      const manifestUrls = new Map(
        releases.flatMap(({ assets }) =>
          assets
            .filter(({ name }) => name.startsWith('latest'))
            .map(({ id, name }) => [
              `https://api.github.com/repos/stablyai/orca/releases/assets/${id}`,
              name === 'latest.yml'
                ? 'path: orca-windows-setup.exe\n'
                : name === 'latest-mac.yml'
                  ? 'minimumSystemVersion: 22.0.0\n'
                  : ''
            ])
        )
      )
      const fetchImpl = vi.fn(async (url, options) => {
        if (url === 'https://api.github.com/repos/stablyai/orca/releases?per_page=100') {
          return jsonResponse(releases)
        }
        if (manifestUrls.has(url) && !options.method) {
          return jsonResponse(manifestUrls.get(url))
        }
        if (url === 'https://api.github.com/repos/stablyai/orca/git/ref/tags/v1.4.2-rc.7') {
          return jsonResponse({
            ref: 'refs/tags/v1.4.2-rc.7',
            object: { type: 'commit', sha: releaseSha }
          })
        }
        if (url.includes('/contents/.github/workflows/release-policy.yml?ref=')) {
          return jsonResponse({ content: Buffer.from('RELEASE_APP_BOT_ID').toString('base64') })
        }
        if (
          url === 'https://api.github.com/repos/stablyai/orca/releases/7' &&
          options.method === 'PATCH'
        ) {
          return jsonResponse({ tag_name: 'v1.4.2-rc.7', draft: false })
        }
        throw new Error(`Unexpected release request: ${options.method ?? 'GET'} ${url}`)
      })
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
      try {
        const result = await publishCompleteDraftReleases({
          repo: 'stablyai/orca',
          token: 'token',
          fetchImpl,
          isDraftBuiltFromCurrentRef: ({ tag }) => isTagBuiltFromCurrentRef(tag, { cwd: repo }),
          verifyAssetProvenance: async () => {},
          verifyDraftTag: () => {},
          log: vi.fn()
        })
        expect(result).toEqual({
          published: ['v1.4.2-rc.7'],
          skipped: [
            { tag: 'v1.4.2-rc.8', reason: 'Release v1.4.2-rc.8 is missing required assets.' }
          ]
        })
        expect(fetchImpl.mock.calls.filter(([, options]) => options.method === 'PATCH')).toEqual([
          [
            'https://api.github.com/repos/stablyai/orca/releases/7',
            expect.objectContaining({
              method: 'PATCH',
              body: JSON.stringify({ tag_name: 'v1.4.2-rc.7', draft: false, prerelease: true })
            })
          ]
        ])
      } finally {
        fetch.mockRestore()
      }
    })
  })

  it('skips stale complete drafts before publishing', async () => {
    await withGitRepo(async (repo) => {
      commit(repo, 'old release source')
      git(repo, ['tag', 'v1.4.2-rc.7'])
      commit(repo, 'current release source')
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        jsonResponse([
          {
            id: 7,
            draft: true,
            tag_name: 'v1.4.2-rc.7',
            created_at: '2026-05-15T07:31:19Z',
            author: APP_BOT,
            assets: getRequiredReleaseAssetNames('v1.4.2-rc.7').map((name) => ({
              name,
              state: 'uploaded',
              size: 1
            }))
          }
        ])
      )
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
      try {
        const result = await publishCompleteDraftReleases({
          repo: 'stablyai/orca',
          token: 'token',
          fetchImpl,
          isDraftBuiltFromCurrentRef: ({ tag }) => isTagBuiltFromCurrentRef(tag, { cwd: repo }),
          verifyAssetProvenance: async () => {},
          log: vi.fn()
        })
        expect(result).toEqual({
          published: [],
          skipped: [{ tag: 'v1.4.2-rc.7', reason: 'tag is not built from the current release ref' }]
        })
        expect(fetchImpl).toHaveBeenCalledTimes(1)
      } finally {
        fetch.mockRestore()
      }
    })
  })
})

describe('RC draft tag verification', () => {
  beforeEach(() => vi.stubEnv('RELEASE_APP_BOT_ID', '356766123'))
  afterEach(() => vi.unstubAllEnvs())

  const releaseSha = 'a'.repeat(40)
  const tagObject = 'b'.repeat(40)
  const draft = {
    id: 9,
    draft: true,
    tag_name: 'v1.4.3-rc.1',
    target_commitish: releaseSha,
    author: { login: 'orca-release[bot]', id: 356766123, type: 'Bot' }
  }
  const ref = (object) => ({ ref: 'refs/tags/v1.4.3-rc.1', object })

  async function run(
    release,
    tagRef,
    { oldPolicy = false, pipelineTag = false, verifyDraftTag = () => {} } = {}
  ) {
    const patches = []
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (url.endsWith('/releases?per_page=100')) {
        return jsonResponse([release])
      }
      if (url.endsWith(`/git/ref/tags/${release.tag_name}`)) {
        return tagRef ? jsonResponse(tagRef) : jsonResponse({}, { ok: false, status: 404 })
      }
      if (url.endsWith(`/git/tags/${tagObject}`)) {
        return jsonResponse({
          sha: tagObject,
          tagger: {
            email: pipelineTag
              ? '41898282+github-actions[bot]@users.noreply.github.com'
              : 'person@example.com'
          },
          object: { type: 'commit', sha: releaseSha }
        })
      }
      if (url.endsWith(`/git/commits/${releaseSha}`)) {
        return jsonResponse({ message: 'release: v1.4.3-rc.1' })
      }
      if (url.includes('/contents/.github/workflows/release-policy.yml?ref=')) {
        const policy = oldPolicy ? 'name: Release Policy' : 'RELEASE_APP_BOT_ID: x'
        return jsonResponse({ content: Buffer.from(policy).toString('base64') })
      }
      if (options.method === 'PATCH') {
        patches.push(JSON.parse(options.body))
        return jsonResponse({ ...release, draft: false })
      }
      throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${url}`)
    })
    const result = await publishCompleteDraftReleases({
      repo: 'stablyai/orca',
      token: 'token',
      fetchImpl,
      verifyReleaseAssets: async () => {},
      isDraftBuiltFromCurrentRef: () => true,
      verifyAssetProvenance: async () => {},
      verifyDraftTag,
      log: vi.fn()
    })
    return { result, patches }
  }

  it('refuses a draft whose build run cannot be verified', async () => {
    const patches = []
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (options.method === 'PATCH') {
        patches.push(url)
      }
      return jsonResponse([draft])
    })
    const result = await publishCompleteDraftReleases({
      repo: 'stablyai/orca',
      token: 'token',
      fetchImpl,
      verifyReleaseAssets: async () => {},
      isDraftBuiltFromCurrentRef: () => true,
      log: vi.fn()
    })
    expect(result.published).toEqual([])
    expect(result.skipped[0].reason).toMatch(/actions: read token is required/)
    expect(patches).toEqual([])
  })

  it('publishes an App-authored draft whose annotated tag still resolves to its commit', async () => {
    const { result, patches } = await run(draft, ref({ type: 'tag', sha: tagObject }))
    expect(result.published).toEqual(['v1.4.3-rc.1'])
    expect(patches).toEqual([{ tag_name: 'v1.4.3-rc.1', draft: false, prerelease: true }])
  })

  it('publishes under an older Release Policy only when the pipeline made the tag', async () => {
    const tagRef = ref({ type: 'tag', sha: tagObject })
    const { result } = await run(draft, tagRef, { oldPolicy: true, pipelineTag: true })
    expect(result.published).toEqual(['v1.4.3-rc.1'])
  })

  it.each([
    ['a moved tag', draft, ref({ type: 'commit', sha: 'c'.repeat(40) }), {}],
    ['a deleted tag', draft, null, {}],
    [
      'a default-branch target',
      { ...draft, target_commitish: 'main' },
      ref({ type: 'commit', sha: releaseSha }),
      {}
    ],
    [
      'an older Release Policy and a hand-made tag',
      draft,
      ref({ type: 'tag', sha: tagObject }),
      { oldPolicy: true }
    ]
  ])('leaves a draft it cannot verify unpublished: %s', async (_name, release, tagRef, options) => {
    const { result, patches } = await run(release, tagRef, options)
    expect(result.published).toEqual([])
    expect(result.skipped).toHaveLength(1)
    expect(patches).toEqual([])
  })

  it('checks the tag object and commit it peeled before publishing, and refuses when the check fails', async () => {
    const seen = []
    const tagRef = ref({ type: 'tag', sha: tagObject })
    const accepted = await run(draft, tagRef, { verifyDraftTag: (args) => seen.push(args) })
    expect(seen).toEqual([{ tag: 'v1.4.3-rc.1', tagObjectSha: tagObject, commitSha: releaseSha }])
    expect(accepted.patches).toHaveLength(1)
    const refused = await run(draft, tagRef, {
      verifyDraftTag: () => {
        throw new Error('tag source is not on main')
      }
    })
    expect(refused.result.skipped).toEqual([
      { tag: 'v1.4.3-rc.1', reason: 'tag source is not on main' }
    ])
    expect(refused.patches).toEqual([])
  })

  it('recognizes only the App by its user ID', () => {
    expect(isReleaseCutDraft(draft)).toBe(true)
    // A github-actions[bot] draft can be made by any workflow with a write token.
    expect(
      isReleaseCutDraft({
        ...draft,
        author: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }
      })
    ).toBe(false)
    expect(isReleaseCutDraft({ ...draft, author: { ...draft.author, id: 1 } })).toBe(false)
    vi.stubEnv('RELEASE_APP_BOT_ID', '')
    expect(isReleaseCutDraft(draft)).toBe(false)
  })
})

// A re-pointed draft must name a tag release-cut would make, on a version bump of a main commit.
describe.skipIf(process.platform === 'win32')('verifyDraftReleaseTag', () => {
  const BOT = 'github-actions[bot]'
  const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: BOT,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1'
  }
  let dir
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))
  const run = (args, extraEnv = {}) =>
    execFileSync('git', args, { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' }).trim()
  const writePackage = (version) =>
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'orca', version }, null, 2)}\n`
    )

  // main: source; release commit is source's package.json-only child, tagged as release-cut tags it.
  function setup({ offMain = false, extraFile = false, tagger = {}, lightweight = false } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'orca-draft-tag-'))
    run(['init', '-q', '--initial-branch=main'])
    writePackage('1.4.2')
    run(['add', '.'])
    run(['commit', '-qm', 'base'])
    run(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    if (offMain) {
      run(['commit', '-q', '--allow-empty', '-m', 'unreviewed'])
    }
    writePackage('1.4.3-rc.1')
    if (extraFile) {
      writeFileSync(join(dir, 'payload.sh'), 'echo hi\n')
    }
    run(['add', '.'])
    run(['commit', '-qm', 'release: v1.4.3-rc.1 [rc-slot:2026-11-14-03]'])
    const commitSha = run(['rev-parse', 'HEAD'])
    run(
      lightweight ? ['tag', 'v1.4.3-rc.1'] : ['tag', '-a', 'v1.4.3-rc.1', '-m', 'v1.4.3-rc.1'],
      tagger
    )
    const tagObjectSha = run(['rev-parse', 'refs/tags/v1.4.3-rc.1'])
    return { tag: 'v1.4.3-rc.1', tagObjectSha, commitSha, cwd: dir }
  }

  it('accepts the tag release-cut makes on a version bump of a main commit', () => {
    expect(() => verifyDraftReleaseTag(setup())).not.toThrow()
  })

  it.each([
    ['a source that is not on main', { offMain: true }, {}, 'tag source is not on main'],
    [
      'a commit that changes more than the version',
      { extraFile: true },
      {},
      'tag is not one release-cut creates'
    ],
    [
      'another tagger',
      { tagger: { GIT_COMMITTER_NAME: 'mallory' } },
      {},
      'tag is not one release-cut creates'
    ],
    ['a lightweight tag', { lightweight: true }, {}, 'tag is not one release-cut creates'],
    [
      'a tag object other than the remote one',
      {},
      { tagObjectSha: 'f'.repeat(40) },
      'release checkout has a different tag object than the remote'
    ],
    [
      'no annotated tag object from the API',
      {},
      { tagObjectSha: undefined },
      'remote tag is not an annotated tag'
    ]
  ])('refuses %s', (_name, options, override, reason) => {
    const args = { ...setup(options), ...override }
    expect(() => verifyDraftReleaseTag(args)).toThrow(reason)
  })

  it('refuses a release commit with two parents', () => {
    const args = setup()
    run(['checkout', '-q', '-b', 'side', 'HEAD~1'])
    run(['commit', '-q', '--allow-empty', '-m', 'side'])
    run(['checkout', '-q', 'main'])
    run(['merge', '-q', '--no-ff', '-m', 'release: v1.4.3-rc.1', 'side'])
    run(['tag', '-f', '-a', 'v1.4.3-rc.1', '-m', 'v1.4.3-rc.1'])
    const merge = run(['rev-parse', 'HEAD'])
    const tagObjectSha = run(['rev-parse', 'refs/tags/v1.4.3-rc.1'])
    expect(() => verifyDraftReleaseTag({ ...args, tagObjectSha, commitSha: merge })).toThrow(
      'draft commit does not have exactly one parent'
    )
  })
})
