import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

const workflowsDir = fileURLToPath(new URL('../../.github/workflows', import.meta.url))

// Every script whose chain reaches build:mobile-web. build:unpack -> build -> build:desktop, and
// build:mac/linux/win each call build:desktop, so all of them produce out/mobile-web. The chain
// itself is not an assumption here: 'the build scripts' below resolves each one for real.
const BUNDLE_PRODUCING_SCRIPTS = [
  'build',
  'build:desktop',
  'build:release',
  'build:release:parallel',
  'build:unpack',
  'build:mobile-web',
  'build:mac',
  'build:mac:release',
  'build:linux',
  'build:win'
]

const BUNDLE_PRODUCER = new RegExp(
  `pnpm (?:run )?(?:${BUNDLE_PRODUCING_SCRIPTS.join('|')})(?=$|[\\s'"&|;])`,
  'm'
)

const packageScripts = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
).scripts

const SCRIPT_INVOCATION = /pnpm (?:run )?([\w:-]+)(?=$|[\s'"&|;])/g

/** Whether `pnpm run <name>` eventually runs build:mobile-web. */
function reachesBundleBuild(name, seen = new Set()) {
  if (name === 'build:mobile-web') {
    return true
  }
  if (seen.has(name)) {
    return false
  }
  seen.add(name)
  const body = packageScripts[name]
  if (typeof body !== 'string') {
    return false
  }
  return [...body.matchAll(SCRIPT_INVOCATION)].some((match) => reachesBundleBuild(match[1], seen))
}

/**
 * Whether `pnpm run <name>` eventually runs electron-builder without --prepackaged, i.e. runs
 * beforePack. A workflow job that packs through such a script is a packaging job even though the
 * literal electron-builder line lives in package.json (daemon-relocation-spike's build:unpack).
 */
function reachesElectronBuilder(name, seen = new Set()) {
  if (seen.has(name)) {
    return false
  }
  seen.add(name)
  const body = packageScripts[name]
  if (typeof body !== 'string') {
    return false
  }
  if (packsWithBeforePack(body)) {
    return true
  }
  return [...body.matchAll(SCRIPT_INVOCATION)].some((match) =>
    reachesElectronBuilder(match[1], seen)
  )
}

/** Whether text invokes electron-builder in a way that reaches beforePack. */
function packsWithBeforePack(text) {
  const invocations = [...text.matchAll(/[^\n]*electron-builder --config[^\n]*/g)].map(
    (match) => match[0]
  )
  // --prepackaged short-circuits doPack before emitBeforePack, so those jobs never run the guard.
  return (
    invocations.length > 0 &&
    !invocations.every((invocation) => invocation.includes('--prepackaged'))
  )
}

// Every job that packs an app and therefore runs beforePack. Listed so that a new packaging
// workflow has to be added here deliberately, with its bundle step, rather than slipping in.
const EXPECTED_PACKAGING_JOBS = [
  'adhoc-mac-build.yml build-adhoc-mac',
  'daemon-relocation-spike.yml spike',
  'daily-mac-build.yml build-daily-mac',
  'dev-channel-win-build.yml build-win',
  'hourly-mac-build.yml build-hourly-mac',
  'pr.yml package',
  'pr.yml package_windows',
  'release-cut.yml build',
  'release-mac-build.yml build-mac',
  'win-crash-survival-e2e.yml crash-survival',
  'win-update-survival-e2e.yml survival',
  'windows-signing-rehearsal.yml rehearse'
]

/**
 * Raw source text per job, sliced by the parsed job boundaries. Why not yaml.stringify(job):
 * re-serializing folds long lines, and the fold in dev-channel-win-build's build-win landed
 * between `electron-builder` and `--config`, hiding a whole packaging job from this census.
 */
function packagingJobs() {
  const jobs = []
  for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
    const source = readFileSync(join(workflowsDir, file), 'utf8')
    const jobsNode = parseDocument(source).get('jobs', true)
    const items = jobsNode?.items ?? []
    for (const [index, pair] of items.entries()) {
      const end = index + 1 < items.length ? items[index + 1].key.range[0] : jobsNode.range[2]
      const text = source.slice(pair.key.range[0], end)
      const packsViaScript = [...text.matchAll(SCRIPT_INVOCATION)].some((match) =>
        reachesElectronBuilder(match[1])
      )
      if (!packsWithBeforePack(text) && !packsViaScript) {
        continue
      }
      jobs.push({ label: `${file} ${String(pair.key.value)}`, text })
    }
  }
  return jobs
}

describe('mobile web bundle packaging coverage', () => {
  it('finds every packaging job', () => {
    // A rename or a restructure that shrank this list would make every assertion below vacuous.
    const labels = packagingJobs().map((job) => job.label)
    expect(labels.length).toBeGreaterThanOrEqual(EXPECTED_PACKAGING_JOBS.length)
    expect(labels.toSorted()).toEqual(EXPECTED_PACKAGING_JOBS.toSorted())
  })

  it.each(packagingJobs().map((job) => [job.label, job]))(
    'produces out/mobile-web before electron-builder packs: %s',
    (_label, job) => {
      // Job granularity, not step ordering: the failure this exists for is a job that never builds
      // the bundle at all, which is what beforePack turns into a hard packaging failure.
      expect(job.text).toMatch(BUNDLE_PRODUCER)
    }
  )

  it.each(packagingJobs().map((job) => [job.label, job]))(
    'installs mobile/node_modules before electron-builder packs: %s',
    (_label, job) => {
      // mobile is a separate pnpm project, so the root install leaves it empty and the bundle
      // build cannot resolve React Native or Expo. One definition, so no job hand-rolls it.
      expect(job.text).toContain('uses: ./.github/actions/install-mobile-dependencies')
    }
  )
})

describe('the build scripts the census trusts', () => {
  // The census only checks that a packaging job invokes one of these. If a chain stopped calling
  // build:mobile-web, every job would still look covered while packaging failed at beforePack.
  it.each(BUNDLE_PRODUCING_SCRIPTS)('%s runs build:mobile-web', (name) => {
    expect(packageScripts[name]).toBeTypeOf('string')
    expect(reachesBundleBuild(name)).toBe(true)
  })

  it('pr.yml package builds the bundle by hand, because it never calls build:release', () => {
    const source = readFileSync(join(workflowsDir, 'pr.yml'), 'utf8')
    expect(source).toMatch(/- name: Build mobile web bundle\n\s+run: pnpm run build:mobile-web\n/)
  })
})
