import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatReleaseTitleTimestamp } from './release-title-timestamp.mjs'
import {
  readPublishedVersionsFromEnv,
  resolveDevChannelBaseVersion
} from './dev-channel-base-version.mjs'

/** Long enough to name a feature, short enough that a picker row stays readable. */
export const ADHOC_LABEL_MAX_LENGTH = 32

// UTC seconds avoid tag collisions between concurrent branch builds; hourly runs serialize and can use minutes.
export function createAdhocBuildVersion(baseVersion, date) {
  const match = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(baseVersion)
  if (!match) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Adhoc build timestamp is invalid.')
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join('')
  // Strip RC tail so adhoc sorts below RC/hourly/stable; routine update checks must not offer unreviewed branch builds.
  return `${match[1]}-adhoc.${stamp}`
}

// Replace title separators/newlines from dispatch labels to prevent forged fields and broken GITHUB_OUTPUT lines.
export function normalizeAdhocLabel(label) {
  const cleaned = String(label ?? '')
    // `refs/heads/x` and `origin/x` are what a ref input tends to arrive as; the
    // prefix is noise in a title where every row is already a branch build.
    .replace(/^(?:refs\/heads\/|origin\/)/, '')
    .replace(/[^\p{L}\p{N}._/-]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, ADHOC_LABEL_MAX_LENGTH)
    // Truncation can land mid-separator, leaving a title ending in `-` or `/`.
    .replace(/[-._/]+$/, '')
  if (!cleaned) {
    throw new Error(`Adhoc label has no usable characters: ${JSON.stringify(label)}`)
  }
  return cleaned
}

// Release title names the branch where hourly uses a counter, distinguishing simultaneous adhoc builds in the picker.
export function formatAdhocReleaseName(version, label, commit, date) {
  return [
    version.split('-')[0],
    normalizeAdhocLabel(label),
    formatReleaseTitleTimestamp(date),
    commit.slice(0, 7)
  ].join(' • ')
}

export function getAdhocBuildIdentity(now = new Date(), label = '', publishedVersions = []) {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const base = resolveDevChannelBaseVersion(packageJson.version, publishedVersions)
  const version = createAdhocBuildVersion(base, now)
  return {
    commit,
    version,
    label: normalizeAdhocLabel(label),
    name: formatAdhocReleaseName(version, label, commit, now)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getAdhocBuildIdentity(
    new Date(),
    process.env.ORCA_ADHOC_LABEL ?? '',
    readPublishedVersionsFromEnv()
  )
  // Consumed by the workflow via $GITHUB_OUTPUT.
  process.stdout.write(
    `version=${identity.version}\ncommit=${identity.commit}\nlabel=${identity.label}\nname=${identity.name}\n`
  )
}
