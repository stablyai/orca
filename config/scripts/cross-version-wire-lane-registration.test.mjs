import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

/**
 * Every cross-version wire suite must run on some machine.
 *
 * PR CI runs `tests/e2e/**` in the sharded unit job, EXCEPT this directory: the suites here
 * skew current code against an extracted release, which needs the full history and tags the
 * shard's shallow clone does not have. So the shard excludes the directory wholesale and the
 * `cross-version-wire` job is the only lane that runs it.
 *
 * That made the job's vitest argv the single thing deciding whether a file executes, and for
 * a while the argv was a curated list of seven paths while the directory held nine suites.
 * `orchestration-delivery-downgrade` and `published-field-shape` ran on no machine and
 * reported nothing; the first could not have passed if it had run, because it extracts a
 * checkout no sibling shares and had no timeout to cover it. Nobody could find that out.
 *
 * Both halves matter and being in one is not enough: `CROSS_VERSION_WIRE_PREFIXES` in
 * pr-code-change-scope.mjs decides whether the job RUNS for a diff, and the argv decides
 * whether the FILE runs once the job started.
 */

const projectDir = resolve(import.meta.dirname, '../..')
const LANE_JOB = 'cross-version-wire'
const LANE_STEP = 'Old/new client and server compatibility journeys'
const LANE_DIRECTORY = 'tests/e2e/cross-version-wire'
const UNIT_TEST_WORKFLOW = '.github/workflows/unit-tests.yml'

/** What `config/vitest.config.ts` collects from `tests/e2e/**`. */
const SUITE_PATTERN = /\.unit\.test\.ts$/

/**
 * Floor for the suite population, so a broken directory read cannot make every assertion
 * below vacuous by finding nothing. Only ever lowered when a suite is genuinely deleted.
 */
const SUITE_FLOOR = 9

function readWorkflow(relativePath) {
  return parse(readFileSync(join(projectDir, relativePath), 'utf8'))
}

/** The vitest argv of the lane's one test step. */
function readLaneArgv() {
  const workflow = readWorkflow('.github/workflows/pr.yml')
  const job = workflow.jobs?.[LANE_JOB]
  if (!job) {
    throw new Error(
      `No ${LANE_JOB} job in .github/workflows/pr.yml. If it was renamed, update LANE_JOB here -- do not delete this guard.`
    )
  }
  const step = (job.steps ?? []).find((candidate) => candidate?.name === LANE_STEP)
  if (!step) {
    throw new Error(
      `No "${LANE_STEP}" step in the ${LANE_JOB} job. If it was renamed, update LANE_STEP here -- do not delete this guard.`
    )
  }
  const run = String(step.run ?? '')
  if (!run.includes('vitest run')) {
    throw new Error(`The "${LANE_STEP}" step no longer invokes vitest; this guard is stale.`)
  }
  return run.split(/\s+/).filter((token) => token.startsWith(`${LANE_DIRECTORY}`))
}

const laneArgv = readLaneArgv()
const suites = readdirSync(join(projectDir, LANE_DIRECTORY))
  .filter((name) => SUITE_PATTERN.test(name))
  .map((name) => `${LANE_DIRECTORY}/${name}`)
  .sort()

/** A vitest positional selects a file when it names the file or a directory above it. */
function selectedByLane(path) {
  return laneArgv.some((token) => path === token || path.startsWith(token))
}

describe('cross-version wire suites run somewhere', () => {
  it('reads a plausible number of suites', () => {
    expect(suites.length).toBeGreaterThanOrEqual(SUITE_FLOOR)
  })

  it('selects every suite in the directory from the lane argv', () => {
    expect(laneArgv.length).toBeGreaterThan(0)
    expect(suites.filter((path) => !selectedByLane(path))).toEqual([])
  })

  it('names no argv path that is not a suite on disk', () => {
    // A curated list rots the other way too: a renamed file leaves a filter matching nothing,
    // and vitest then fails the whole lane rather than quietly running the rest.
    const strays = laneArgv.filter(
      (token) =>
        token !== `${LANE_DIRECTORY}/` && token !== LANE_DIRECTORY && !suites.includes(token)
    )
    expect(strays).toEqual([])
  })

  it('keeps the unit shards excluding the directory, which is what makes this lane the only one', () => {
    const workflow = readWorkflow(UNIT_TEST_WORKFLOW)
    const shardStep = (workflow.jobs?.test?.steps ?? []).find(
      (step) => typeof step?.run === 'string' && step.run.includes('vitest run')
    )
    expect(shardStep, `no sharded vitest step in ${UNIT_TEST_WORKFLOW}`).toBeDefined()
    // If this exclusion is ever dropped the suites gain a second lane, and the argv stops
    // being the only thing that decides whether a file runs. Revisit this guard, do not
    // delete it: the shallow shard clone has no tags for an extracted release to skew against.
    expect(String(shardStep.run)).toContain(`--exclude=${LANE_DIRECTORY}/**`)
  })

  it('runs the lane for a change to any suite it owns', () => {
    for (const path of suites) {
      expect(classifyPrJobs([path])[LANE_JOB], path).toBe(true)
    }
  })
})
