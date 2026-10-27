import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  isTagBuiltFromCurrentRef,
  isReleaseCutDraft,
  publishCompleteDraftReleases,
  writeGithubOutputs
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

describe('isReleaseCutDraft', () => {
  it('only accepts bot-authored desktop draft releases', () => {
    expect(
      isReleaseCutDraft({
        draft: true,
        tag_name: 'v1.4.2-rc.7',
        author: { login: 'github-actions[bot]' }
      })
    ).toBe(true)
    expect(
      isReleaseCutDraft({
        draft: true,
        tag_name: 'mobile-v0.0.7',
        author: { login: 'github-actions[bot]' }
      })
    ).toBe(false)
    expect(
      isReleaseCutDraft({
        draft: true,
        tag_name: 'v1.4.2',
        author: { login: 'github-actions[bot]' }
      })
    ).toBe(false)
    expect(
      isReleaseCutDraft({
        draft: false,
        tag_name: 'v1.4.2',
        author: { login: 'github-actions[bot]' }
      })
    ).toBe(false)
    expect(
      isReleaseCutDraft({
        draft: false,
        tag_name: 'v1.4.2-rc.7',
        author: { login: 'github-actions[bot]' }
      })
    ).toBe(false)
    expect(
      isReleaseCutDraft({
        draft: true,
        tag_name: 'v1.4.2-rc.7',
        author: { login: 'release-maintainer' }
      })
    ).toBe(false)
  })
})

describe('isTagBuiltFromCurrentRef', () => {
  it('accepts a tag on the current release commit', async () => {
    await withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(true)
    })
  })

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

  it('rejects a stale tag when the current ref has moved on', async () => {
    await withGitRepo((repo) => {
      commit(repo, 'initial')
      commit(repo, 'release: v1.4.36-rc.6')
      git(repo, ['tag', 'v1.4.36-rc.6'])
      commit(repo, 'fix: release packaging')

      expect(isTagBuiltFromCurrentRef('v1.4.36-rc.6', { cwd: repo })).toBe(false)
    })
  })
})

describe('publishCompleteDraftReleases', () => {
  it('publishes complete release-cut drafts and skips incomplete ones', async () => {
    await withGitRepo(async (repo) => {
      commit(repo, 'release source')
      git(repo, ['tag', 'v1.4.2-rc.7'])
      git(repo, ['tag', 'v1.4.2-rc.8'])
      const releases = [7, 8].map((id) => ({
        id,
        draft: true,
        tag_name: `v1.4.2-rc.${id}`,
        created_at: `2026-05-15T0${id}:31:19Z`,
        author: { login: 'github-actions[bot]' },
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
              name === 'latest.yml' ? 'path: orca-windows-setup.exe\n' : ''
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
              body: JSON.stringify({ draft: false, prerelease: true })
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
            author: { login: 'github-actions[bot]' },
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

describe('writeGithubOutputs', () => {
  it('writes count outputs for workflow conditions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-release-outputs-'))
    const outputPath = join(dir, 'output')
    try {
      writeGithubOutputs(
        {
          published: ['v1.4.2-rc.7'],
          skipped: [{ tag: 'v1.4.2-rc.8', reason: 'missing assets' }]
        },
        outputPath
      )

      expect(readFileSync(outputPath, 'utf8')).toBe(
        `${[
          'published_count=1',
          'skipped_count=1',
          'latest_published_tag=v1.4.2-rc.7',
          'published_tags=v1.4.2-rc.7',
          'skipped_tags=v1.4.2-rc.8'
        ].join('\n')}\n`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
