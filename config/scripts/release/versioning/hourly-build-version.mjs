import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatReleaseTitleTimestamp } from './release-title-timestamp.mjs'
import {
  readPublishedVersionsFromEnv,
  resolveDevChannelBaseVersion
} from './dev-channel-base-version.mjs'

// UTC minute tags sort chronologically by semver.
export function createHourlyBuildVersion(baseVersion, date) {
  const match = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(baseVersion)
  if (!match) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Hourly build timestamp is invalid.')
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes())
  ].join('')
  // Strip RC tail: rc.N-hourly outranks RC and would offer untested builds automatically; base-hourly stays below RC/stable for explicit selection.
  return `${match[1]}-hourly.${stamp}`
}

// Restart numbering per base; take max release-title number, not count, so retention pruning cannot reissue numbers. Legacy unmatched titles yield 01.
export function nextHourlyBuildNumber(baseVersion, releaseNames = []) {
  const prefix = `${baseVersion} • `
  const highest = releaseNames.reduce((max, entry) => {
    const name = String(entry ?? '')
    if (!name.startsWith(prefix)) {
      return max
    }
    const match = /^(\d+) • /.exec(name.slice(prefix.length))
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return highest + 1
}

// Release title shown verbatim in GitHub/build picker: 1.4.163 • 01 • Jul 31, 1:54PM • e698241.
export function formatHourlyReleaseName(version, buildNumber, commit, date) {
  if (!Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Hourly build number must be a positive integer: ${buildNumber}`)
  }
  return [
    version.split('-')[0],
    String(buildNumber).padStart(2, '0'),
    formatReleaseTitleTimestamp(date),
    commit.slice(0, 7)
  ].join(' • ')
}

// Resolve published tags before counting so numbering uses actual base version, not caller’s guess.
export function getHourlyBuildIdentity(
  now = new Date(),
  { packageVersion, publishedVersions, releaseNames } = {}
) {
  const versionFromPackage =
    packageVersion ?? JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const base = resolveDevChannelBaseVersion(versionFromPackage, publishedVersions ?? [])
  const version = createHourlyBuildVersion(base, now)
  const buildNumber = nextHourlyBuildNumber(base, releaseNames ?? [])
  return {
    commit,
    version,
    buildNumber,
    name: formatHourlyReleaseName(version, buildNumber, commit, now)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getHourlyBuildIdentity(new Date(), {
    publishedVersions: readPublishedVersionsFromEnv(),
    // Titles are newline separated and contain spaces, so this cannot reuse the
    // whitespace split the version list gets.
    releaseNames: (process.env.ORCA_HOURLY_RELEASE_NAMES ?? '').split('\n').filter(Boolean)
  })
  process.stdout.write(
    `version=${identity.version}\ncommit=${identity.commit}\nbuild_number=${identity.buildNumber}\nname=${identity.name}\n`
  )
}
