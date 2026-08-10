import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatReleaseTitleTimestamp } from './release-title-timestamp.mjs'
import {
  readPublishedVersionsFromEnv,
  resolveDevChannelBaseVersion
} from './dev-channel-base-version.mjs'

/** `1.4.160-daily.202607281300` — UTC to the minute, so tags sort chronologically
 *  by semver and every build is uniquely versioned. */
export function createDailyBuildVersion(baseVersion, date) {
  const match = /^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(baseVersion)
  if (!match) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('Daily build timestamp is invalid.')
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp = [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes())
  ].join('')
  // Why: drop any -rc.N tail. Keeping it makes every daily semver-NEWER than the
  // RC it was cut from (1.4.160-rc.3-daily.X > 1.4.160-rc.3), which would let an
  // ordinary RC-channel check offer untested daily builds to RC users. Stripping
  // to the base parks dailies below both rc.N and stable ('daily' < 'rc'
  // alphabetically), reachable only by an explicit pinned jump.
  return `${match[1]}-daily.${stamp}`
}

/**
 * The next build number for `baseVersion`, counting from the titles of existing
 * daily releases.
 *
 * Why the series restarts at 01 on every base version: the number answers "which
 * build of 1.4.163 is this", so a counter shared across versions makes it
 * meaningless — 1.4.164 would open at 38 for no reason a reader can see.
 *
 * Why the maximum rather than a count: the prune step trims to
 * DAILY_RETAIN_COUNT, so a count would roll backwards and reissue a number
 * already in use. Titles that predate this naming simply do not match, which is
 * how the first build of a version lands on 01.
 */
export function nextDailyBuildNumber(baseVersion, releaseNames = []) {
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

/**
 * `1.4.163 • 01 • Aug 9, 6:15AM • e698241` — the human-facing release title,
 * shown verbatim in both the GitHub releases list and the in-app build picker.
 */
export function formatDailyReleaseName(version, buildNumber, commit, date) {
  if (!Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Daily build number must be a positive integer: ${buildNumber}`)
  }
  return [
    version.split('-')[0],
    String(buildNumber).padStart(2, '0'),
    formatReleaseTitleTimestamp(date),
    commit.slice(0, 7)
  ].join(' • ')
}

// Why the number is derived here rather than passed in: it counts builds of the
// base version, and the base is only known once the published tags have been
// resolved just above. Computing it outside meant numbering against whatever
// version the caller guessed.
export function getDailyBuildIdentity(now = new Date(), { publishedVersions, releaseNames } = {}) {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const base = resolveDevChannelBaseVersion(packageJson.version, publishedVersions ?? [])
  const version = createDailyBuildVersion(base, now)
  const buildNumber = nextDailyBuildNumber(base, releaseNames ?? [])
  return {
    commit,
    version,
    buildNumber,
    name: formatDailyReleaseName(version, buildNumber, commit, now)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getDailyBuildIdentity(new Date(), {
    publishedVersions: readPublishedVersionsFromEnv(),
    // Titles are newline separated and contain spaces, so this cannot reuse the
    // whitespace split the version list gets.
    releaseNames: (process.env.ORCA_DAILY_RELEASE_NAMES ?? '').split('\n').filter(Boolean)
  })
  // Consumed by the workflow via $GITHUB_OUTPUT.
  process.stdout.write(
    `version=${identity.version}\ncommit=${identity.commit}\nbuild_number=${identity.buildNumber}\nname=${identity.name}\n`
  )
}
