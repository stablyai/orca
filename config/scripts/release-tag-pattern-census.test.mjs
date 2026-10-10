import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_RC_TAG,
  DESKTOP_STABLE_TAG,
  agentStateRulesTag,
  isAgentStateRulesTag
} from './release-tag-patterns.mjs'

const RULES_TAGS = [agentStateRulesTag(1, 'next'), agentStateRulesTag(1, 'stable')]
const rulesRelease = (tag, extra = {}) => ({
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: true,
  author: { login: 'github-actions[bot]' },
  assets: [{ name: 'agent-state-rules.json', download_count: 5 }],
  ...extra
})

// Exercise the desktop consumers against rules releases.
const DESKTOP_ONLY_PROOFS = {
  'config/scripts/create-draft-release.mjs': async () => {
    const { latestPreviousPublishedDesktopReleaseTag } = await import('./create-draft-release.mjs')
    const releases = [
      ...RULES_TAGS.map((tag) => rulesRelease(tag)),
      { tag_name: 'v1.4.1', draft: false }
    ]
    expect(latestPreviousPublishedDesktopReleaseTag(releases, 'v1.4.2')).toBe('v1.4.1')
  },
  'config/scripts/publish-complete-draft-releases.mjs': async () => {
    const { isReleaseCutDraft } = await import('./publish-complete-draft-releases.mjs')
    for (const tag of RULES_TAGS) {
      expect(isReleaseCutDraft(rulesRelease(tag, { draft: true }))).toBe(false)
    }
  },
  'config/scripts/latest-stable-release.mjs': async () => {
    const { latestStableDesktopReleaseTag } = await import('./latest-stable-release.mjs')
    const releases = [
      ...RULES_TAGS.map((tag) => rulesRelease(tag, { prerelease: false })),
      { tag_name: 'v1.4.1' }
    ]
    expect(latestStableDesktopReleaseTag(releases)).toBe('v1.4.1')
  },
  'config/scripts/assert-github-release-is-draft.mjs': async () => {
    const { matchingDesktopReleases } = await import('./assert-github-release-is-draft.mjs')
    expect(
      matchingDesktopReleases(
        RULES_TAGS.map((tag) => rulesRelease(tag)),
        'v1.4.1'
      )
    ).toEqual([])
  },
  'config/scripts/verify-release-required-assets.mjs': async () => {
    const { verifyRequiredReleaseAssets } = await import('./verify-release-required-assets.mjs')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(RULES_TAGS.map((tag) => rulesRelease(tag)))))
    )
    await expect(
      verifyRequiredReleaseAssets({ repo: 'stablyai/orca', tag: 'v1.4.1', token: '' })
    ).rejects.toThrow('was not found')
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('release tag pattern census', () => {
  it.each(Object.keys(DESKTOP_ONLY_PROOFS))(
    '%s imports the shared patterns or proves it admits only desktop tags',
    async (path) => {
      const proof = DESKTOP_ONLY_PROOFS[path]
      expect(
        proof,
        `${path} lists releases: import release-tag-patterns.mjs or add a proof`
      ).toBeDefined()
      await proof()
    }
  )

  it('never classifies an agent state rules tag as a desktop release', () => {
    for (const tag of RULES_TAGS) {
      expect(isAgentStateRulesTag(tag)).toBe(true)
      expect(DESKTOP_STABLE_TAG.test(tag) || DESKTOP_RC_TAG.test(tag)).toBe(false)
    }
    expect(() => agentStateRulesTag(1, 'beta')).toThrow()
  })
})
