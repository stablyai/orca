import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  isReleaseCutDraft,
  publishCompleteDraftReleases,
  writeGithubOutputs
} from './publish-complete-draft-releases.mjs'

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
  })
})

describe('publishCompleteDraftReleases', () => {
  it('publishes complete release-cut drafts and skips incomplete ones', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: 7,
            draft: true,
            tag_name: 'v1.4.2-rc.7',
            created_at: '2026-05-15T07:31:19Z',
            author: { login: 'github-actions[bot]' }
          },
          {
            id: 8,
            draft: true,
            tag_name: 'v1.4.2-rc.8',
            created_at: '2026-05-15T10:51:57Z',
            author: { login: 'github-actions[bot]' }
          }
        ])
      )
      .mockResolvedValueOnce(jsonResponse({ tag_name: 'v1.4.2-rc.7', draft: false }))
    const verifyReleaseAssets = vi.fn(async ({ tag }) => {
      if (tag === 'v1.4.2-rc.8') {
        throw new Error('Release v1.4.2-rc.8 is missing required assets.')
      }
    })
    const log = vi.fn()

    const result = await publishCompleteDraftReleases({
      repo: 'stablyai/orca',
      token: 'token',
      fetchImpl,
      verifyReleaseAssets,
      log
    })

    expect(result).toEqual({
      published: ['v1.4.2-rc.7'],
      skipped: [
        {
          tag: 'v1.4.2-rc.8',
          reason: 'Release v1.4.2-rc.8 is missing required assets.'
        }
      ]
    })
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.github.com/repos/stablyai/orca/releases/7',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ draft: false, prerelease: true })
      })
    )
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
          'published_tags=v1.4.2-rc.7',
          'skipped_tags=v1.4.2-rc.8'
        ].join('\n')}\n`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
