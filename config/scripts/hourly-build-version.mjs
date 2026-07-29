import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** `1.4.160-hourly.202607281400` — UTC to the minute, so tags sort chronologically
 *  by semver and every build is uniquely versioned. */
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
  // Why: drop any -rc.N tail. Keeping it makes every hourly semver-NEWER than the
  // RC it was cut from (1.4.160-rc.3-hourly.X > 1.4.160-rc.3), which would let an
  // ordinary RC-channel check offer untested hourly builds to RC users. Stripping
  // to the base parks hourlies below both rc.N and stable ('hourly' < 'rc'
  // alphabetically), reachable only by an explicit pinned jump.
  return `${match[1]}-hourly.${stamp}`
}

export function getHourlyBuildIdentity(now = new Date()) {
  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  return { commit, version: createHourlyBuildVersion(packageJson.version, now) }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getHourlyBuildIdentity()
  // Consumed by the workflow via $GITHUB_OUTPUT.
  process.stdout.write(`version=${identity.version}\ncommit=${identity.commit}\n`)
}
