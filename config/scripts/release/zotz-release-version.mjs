#!/usr/bin/env node
// Zotz release version: MAJOR.MINOR.(orcaPatch × 100 + build), see docs/zotz/UPDATES-SPEC.md §3.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const BUILDS_PER_BASE = 99
// Windows executable version fields are 16-bit.
const MAX_VERSION_PART = 65535

/**
 * @param {string} baseVersion Orca's version from package.json, e.g. "1.4.214".
 * @param {string[]} existingTags Tags already in the repo, e.g. ["v1.4.21401", "v1.4.214"].
 * @returns {{ version: string, tag: string, build: number }}
 */
export function computeZotzReleaseVersion(baseVersion, existingTags) {
  const base = /^(\d+)\.(\d+)\.(\d+)$/.exec(baseVersion)
  if (!base) {
    throw new Error(`package.json version must be MAJOR.MINOR.PATCH, got "${baseVersion}"`)
  }
  const [, major, minor, orcaPatch] = base
  const first = Number(orcaPatch) * 100 + 1
  const last = Number(orcaPatch) * 100 + BUILDS_PER_BASE
  if (last > MAX_VERSION_PART) {
    throw new Error(`Orca patch ${orcaPatch} is too large for the Zotz version scheme`)
  }
  let highest = 0
  for (const tag of existingTags) {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim())
    if (!match || match[1] !== major || match[2] !== minor) {
      continue
    }
    const patch = Number(match[3])
    if (patch >= first && patch <= last) {
      highest = Math.max(highest, patch - first + 1)
    }
  }
  const build = highest + 1
  if (build > BUILDS_PER_BASE) {
    throw new Error(
      `Zotz already published ${BUILDS_PER_BASE} builds on Orca ${baseVersion}; sync with Orca before releasing again`
    )
  }
  const version = `${major}.${minor}.${Number(orcaPatch) * 100 + build}`
  return { version, tag: `v${version}`, build }
}

function listRemoteTags() {
  const output = execFileSync('git', ['ls-remote', '--tags', '--refs', 'origin'], {
    encoding: 'utf8'
  })
  return output
    .split('\n')
    .map((line) => line.split('refs/tags/')[1])
    .filter(Boolean)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { version: baseVersion } = JSON.parse(readFileSync('package.json', 'utf8'))
  const result = computeZotzReleaseVersion(baseVersion, listRemoteTags())
  console.log(`Zotz ${result.version} (Orca ${baseVersion}, build ${result.build})`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\ntag=${result.tag}\nbuild=${result.build}\nbase=${baseVersion}\n`
    )
  }
}
