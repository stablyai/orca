import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatReleaseTitleTimestamp } from './release-title-timestamp.mjs'

/** Long enough to name a feature, short enough that a picker row stays readable. */
export const ADHOC_LABEL_MAX_LENGTH = 32

/**
 * `1.4.160-adhoc.20260728140533` — UTC to the second, so tags sort
 * chronologically by semver and every build is uniquely versioned.
 *
 * Why seconds when hourly uses minutes: hourly runs under a concurrency group and
 * cannot overlap itself. Adhoc builds are dispatched on demand, so two people
 * cutting from different branches in the same minute is ordinary — and a
 * minute-resolution tag would collide and fail the second build after its whole
 * pack-and-notarize run.
 */
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
  // Why: drop any -rc.N tail, same as hourly. Keeping it would make every adhoc
  // build semver-NEWER than the RC it was cut from, letting an ordinary
  // RC-channel check offer an unreviewed branch build to RC users. Stripping to
  // the base parks adhoc below rc.N, hourly, and stable ('adhoc' sorts first
  // alphabetically), reachable only by an explicit pinned jump.
  return `${match[1]}-adhoc.${stamp}`
}

/**
 * Turns a dispatch input into a label safe to put in a release title.
 *
 * The input is free text from whoever ran the workflow, so it cannot be trusted
 * to stay inside the title's shape: a stray `•` would forge a field separator,
 * and a newline would break the `$GITHUB_OUTPUT` line the workflow parses. Both
 * collapse to `-` here, which is why this replaces rather than rejects.
 */
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

/**
 * `1.4.163 • wasm-terminal • 08-01 14:25 • abc1234` — the human-facing release
 * title, shown verbatim in both the GitHub releases list and the build picker.
 *
 * Why the label sits where hourly puts its build number: several adhoc builds
 * from different branches coexist in the channel, so the picker needs the branch
 * to tell them apart. A counter would say nothing about which one to pick.
 */
export function formatAdhocReleaseName(version, label, commit, date) {
  return [
    version.split('-')[0],
    normalizeAdhocLabel(label),
    formatReleaseTitleTimestamp(date),
    commit.slice(0, 7)
  ].join(' • ')
}

export function getAdhocBuildIdentity(now = new Date(), label = '') {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const version = createAdhocBuildVersion(packageJson.version, now)
  return {
    commit,
    version,
    label: normalizeAdhocLabel(label),
    name: formatAdhocReleaseName(version, label, commit, now)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getAdhocBuildIdentity(new Date(), process.env.ORCA_ADHOC_LABEL ?? '')
  // Consumed by the workflow via $GITHUB_OUTPUT.
  process.stdout.write(
    `version=${identity.version}\ncommit=${identity.commit}\nlabel=${identity.label}\nname=${identity.name}\n`
  )
}
