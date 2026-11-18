#!/usr/bin/env node
// Zotz release version: MAJOR.MINOR.(orcaPatch × 100 + build), see docs/zotz/UPDATES-SPEC.md §3.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BUILDS_PER_BASE = 99
// Windows executable version fields are 16-bit.
const MAX_VERSION_PART = 65535
// Orca keeps package.json at an old version on main and bumps it only on release branches.
const ORCA_UPSTREAM_URL = 'https://github.com/stablyai/orca.git'
const ORCA_MAIN_REF = 'refs/zotz/orca-main'
const ORCA_TAG_REF_PREFIX = 'refs/zotz/orca-tags/'
const ORCA_RELEASES_TO_PROBE = 30
// Zotz releases have a five-digit patch; Orca's own tags mirrored into the fork stay below it.
const MIN_ZOTZ_PATCH = 10_000

/** @param {string} tag */
function parseStableTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
  return match ? match.slice(1).map(Number) : null
}

/** @param {number[]} a @param {number[]} b */
function compareVersionParts(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** @param {string[]} tags @returns {string[]} stable vX.Y.Z tags, newest first */
export function stableTagsNewestFirst(tags) {
  return tags
    .map((tag) => ({ tag: tag.trim(), parts: parseStableTag(tag) }))
    .filter((entry) => entry.parts !== null)
    .sort((a, b) => compareVersionParts(b.parts, a.parts))
    .map((entry) => entry.tag)
}

/**
 * Orca base = newest Orca release whose cut from Orca main is already merged into Zotz.
 * @param {string[]} orcaTagsNewestFirst
 * @param {(tag: string) => boolean} isReleaseCutMerged
 */
export function resolveOrcaBase(orcaTagsNewestFirst, isReleaseCutMerged) {
  const tag = orcaTagsNewestFirst.find(isReleaseCutMerged)
  if (!tag) {
    throw new Error(
      'No Orca release is merged into this commit; check the checkout has full history (fetch-depth: 0)'
    )
  }
  return tag.slice(1)
}

/**
 * @param {string} baseVersion Orca release the code is based on, e.g. "1.4.259".
 * @param {string[]} existingTags Tags already in the repo, e.g. ["v1.4.21401", "v1.4.214"].
 * @returns {{ version: string, tag: string, build: number }}
 */
export function computeZotzReleaseVersion(baseVersion, existingTags) {
  const base = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion)
  if (!base) {
    throw new Error(`Orca base version must be MAJOR.MINOR.PATCH, got "${baseVersion}"`)
  }
  const [, major, minor, orcaPatch] = base
  const first = Number(orcaPatch) * 100 + 1
  const last = Number(orcaPatch) * 100 + BUILDS_PER_BASE
  if (last > MAX_VERSION_PART) {
    throw new Error(`Orca patch ${orcaPatch} is too large for the Zotz version scheme`)
  }
  let highest = 0
  let newestZotzRelease = null
  for (const tag of existingTags) {
    const parts = parseStableTag(tag)
    if (!parts) {
      continue
    }
    if (
      parts[2] >= MIN_ZOTZ_PATCH &&
      (!newestZotzRelease || compareVersionParts(parts, newestZotzRelease) > 0)
    ) {
      newestZotzRelease = parts
    }
    if (parts[0] === Number(major) && parts[1] === Number(minor)) {
      if (parts[2] >= first && parts[2] <= last) {
        highest = Math.max(highest, parts[2] - first + 1)
      }
    }
  }
  const build = highest + 1
  if (build > BUILDS_PER_BASE) {
    throw new Error(
      `Zotz already published ${BUILDS_PER_BASE} builds on Orca ${baseVersion}; sync with Orca before releasing again`
    )
  }
  const parts = [Number(major), Number(minor), Number(orcaPatch) * 100 + build]
  const version = parts.join('.')
  // Installed nodes only take a higher version, so a lower base would strand them.
  if (newestZotzRelease && compareVersionParts(parts, newestZotzRelease) <= 0) {
    throw new Error(
      `Zotz ${version} would not be newer than the published v${newestZotzRelease.join('.')}`
    )
  }
  return { version, tag: `v${version}`, build }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function listRemoteTags(remote) {
  return git(['ls-remote', '--tags', '--refs', remote])
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter(Boolean)
}

function resolveOrcaBaseFromUpstream() {
  const candidates = stableTagsNewestFirst(listRemoteTags(ORCA_UPSTREAM_URL)).slice(
    0,
    ORCA_RELEASES_TO_PROBE
  )
  // Own refs so the fork's tags and remotes stay untouched.
  git([
    'fetch',
    '--quiet',
    '--no-tags',
    ORCA_UPSTREAM_URL,
    `+refs/heads/main:${ORCA_MAIN_REF}`,
    ...candidates.map((tag) => `+refs/tags/${tag}:${ORCA_TAG_REF_PREFIX}${tag}`)
  ])
  return resolveOrcaBase(candidates, (tag) => {
    // Orca cuts each release branch from its main; the cut point tells which main code it carries.
    const cut = spawnSync('git', ['merge-base', `${ORCA_TAG_REF_PREFIX}${tag}`, ORCA_MAIN_REF], {
      encoding: 'utf8'
    })
    if (cut.status !== 0) {
      return false
    }
    return spawnSync('git', ['merge-base', '--is-ancestor', cut.stdout.trim(), 'HEAD']).status === 0
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const baseVersion = resolveOrcaBaseFromUpstream()
  const result = computeZotzReleaseVersion(baseVersion, listRemoteTags('origin'))
  console.log(`Zotz ${result.version} (Orca ${baseVersion}, build ${result.build})`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nbuild=${result.build}\nbase=${baseVersion}\n`
    )
  }
}
