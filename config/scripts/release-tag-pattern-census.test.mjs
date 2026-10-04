// Census: every release-triggered workflow and every script that lists this repo's releases
// classifies tags through release-tag-patterns.mjs, so a new tag family such as the agent state
// rules cannot reach a desktop-only path through one that forgot it.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  DESKTOP_RC_TAG,
  DESKTOP_STABLE_TAG,
  DESKTOP_STABLE_TAG_SHELL_PATTERN,
  agentStateRulesTag,
  isAgentStateRulesTag
} from './release-tag-patterns.mjs'

const WORKFLOWS_DIR = '.github/workflows'
const SCRIPT_DIRS = ['config/scripts', '.github/scripts']
const SHARED_IMPORT = /from '[^']*release-tag-patterns\.mjs'/
const LISTS_RELEASES = /\/releases\?|listReleases|releases\.atom|'release',\s*'list'/

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

function read(path) {
  return readFileSync(path, 'utf8')
}

function importsSharedPatterns(path) {
  return SHARED_IMPORT.test(read(path))
}

function isReleaseTriggered(workflow) {
  const on = workflow.on
  if (typeof on === 'string') {
    return on === 'release'
  }
  if (Array.isArray(on)) {
    return on.includes('release')
  }
  return typeof on === 'object' && on !== null && 'release' in on
}

function releaseTriggeredWorkflows() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => join(WORKFLOWS_DIR, name))
    .filter((path) => isReleaseTriggered(parse(read(path))))
}

function scriptsNamedIn(text) {
  return [...text.matchAll(/((?:config|\.github)\/scripts\/[\w.-]+\.mjs)/g)].map(
    (match) => match[1]
  )
}

function releaseListingScripts() {
  return SCRIPT_DIRS.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith('.mjs') && !name.includes('.test.'))
      .map((name) => join(dir, name))
  ).filter((path) => LISTS_RELEASES.test(read(path)))
}

/**
 * Scripts that list releases yet admit only desktop tags by their own shape. Each entry proves,
 * by calling the script, that a rules release never passes; a new listing script must import the
 * shared patterns or add a proof here.
 */
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
  it('finds the release-triggered workflows and release-listing scripts it guards', () => {
    expect(releaseTriggeredWorkflows().length).toBeGreaterThan(0)
    expect(releaseListingScripts().length).toBeGreaterThan(0)
  })

  it.each(releaseTriggeredWorkflows())('%s classifies tags through the shared patterns', (path) => {
    const text = read(path)
    const viaScript = scriptsNamedIn(text).some(importsSharedPatterns)
    const viaShellPattern = text.includes(DESKTOP_STABLE_TAG_SHELL_PATTERN)
    expect(
      viaScript || viaShellPattern,
      `${path} names no script importing release-tag-patterns.mjs and embeds no shared pattern`
    ).toBe(true)
  })

  it.each(releaseTriggeredWorkflows())(
    '%s checks out the shared patterns beside its script',
    (path) => {
      const workflow = parse(read(path))
      const sparse = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .map((step) => step.with?.['sparse-checkout'])
        .filter((value) => typeof value === 'string')
      for (const paths of sparse) {
        if (scriptsNamedIn(paths).some(importsSharedPatterns)) {
          expect(paths).toContain('config/scripts/release-tag-patterns.mjs')
        }
      }
    }
  )

  it.each(releaseListingScripts())(
    '%s imports the shared patterns or proves it admits only desktop tags',
    async (path) => {
      if (importsSharedPatterns(path)) {
        return
      }
      const proof = DESKTOP_ONLY_PROOFS[path]
      expect(
        proof,
        `${path} lists releases: import release-tag-patterns.mjs or add a proof`
      ).toBeDefined()
      await proof()
    }
  )

  it('keeps no proof for a script that no longer lists releases', () => {
    const listing = new Set(releaseListingScripts())
    expect(Object.keys(DESKTOP_ONLY_PROOFS).filter((path) => !listing.has(path))).toEqual([])
  })

  it('never classifies an agent state rules tag as a desktop release', () => {
    for (const tag of RULES_TAGS) {
      expect(isAgentStateRulesTag(tag)).toBe(true)
      expect(DESKTOP_STABLE_TAG.test(tag) || DESKTOP_RC_TAG.test(tag)).toBe(false)
    }
    expect(() => agentStateRulesTag(1, 'beta')).toThrow()
  })
})
