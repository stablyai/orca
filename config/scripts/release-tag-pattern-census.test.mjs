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
    expect(isReleaseCutDraft(rulesRelease('v1.4.2-rc.1', { draft: true }))).toBe(true)
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
    const desktop = { tag_name: 'v1.4.1' }
    expect(
      matchingDesktopReleases([...RULES_TAGS.map((tag) => rulesRelease(tag)), desktop], 'v1.4.1')
    ).toEqual([desktop])
    expect(
      matchingDesktopReleases(
        RULES_TAGS.map((tag) => rulesRelease(tag)),
        'v1.4.1'
      )
    ).toEqual([])
  },
  'config/scripts/verify-release-required-assets.mjs': async () => {
    const { verifyRequiredReleaseAssets } = await import('./verify-release-required-assets.mjs')
    const releases = RULES_TAGS.map((tag) => rulesRelease(tag))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(releases)))
    )
    await expect(
      verifyRequiredReleaseAssets({ repo: 'stablyai/orca', tag: 'v1.4.1', token: '' })
    ).rejects.toThrow('was not found')
    releases.push({ tag_name: 'v1.4.1', assets: [] })
    await expect(
      verifyRequiredReleaseAssets({ repo: 'stablyai/orca', tag: 'v1.4.1', token: '' })
    ).rejects.toThrow('Release v1.4.1 is missing required assets.')
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('release tag pattern census', () => {
  it.each(Object.keys(DESKTOP_ONLY_PROOFS))(
    '%s excludes agent state rules releases from desktop selection',
    async (path) => {
      await DESKTOP_ONLY_PROOFS[path]()
    }
  )

  it('never classifies an agent state rules tag as a desktop release', () => {
    for (const tag of RULES_TAGS) {
      expect(isAgentStateRulesTag(tag)).toBe(true)
      expect(DESKTOP_STABLE_TAG.test(tag) || DESKTOP_RC_TAG.test(tag)).toBe(false)
    }
    expect(DESKTOP_STABLE_TAG.test('v1.4.1')).toBe(true)
    expect(DESKTOP_RC_TAG.test('v1.4.2-rc.1')).toBe(true)
    expect(() => agentStateRulesTag(1, 'beta')).toThrow()
  })
})
