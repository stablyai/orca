import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { UNIT_EXCLUDE } from './ci-unit-files.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

/**
 * Every cross-version wire suite must run on some machine.
 *
 * PR CI runs `tests/e2e/**` in the sharded unit job, EXCEPT this directory: the suites here
 * skew current code against an extracted release, which needs the full history and tags the
 * shard's shallow clone does not have. So the shard excludes the directory wholesale and the
 * `cross-version-wire` job is the only lane that runs it.
 *
 * That made the job's vitest argv the single thing deciding whether a file executes. While it
 * was a curated list, `orchestration-delivery-downgrade`, `agent-session-death-evidence-downgrade`
 * and `published-field-shape` landed in the directory without joining it and ran on no machine.
 *
 * Both halves matter and being in one is not enough: `CROSS_VERSION_WIRE_PREFIXES` in
 * pr-code-change-scope.mjs decides whether the job RUNS for a diff, and the argv decides
 * whether the FILE runs once the job started. So every module a suite pairs has to start the
 * job too, or a change to it breaks the pairing on a PR that never runs the lane.
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

/**
 * The release-checkout machinery extracts a tree and pairs nothing; `release-checkout.unit.test.ts`
 * feeds it made-up paths on purpose.
 */
const CHECKOUT_MACHINERY = new Set([
  'release-checkout.ts',
  'release-checkout-tree.ts',
  'release-checkout.unit.test.ts'
])

/** A working-tree import, static or dynamic, from a suite or a wire helper it loads through. */
const WORKING_TREE_IMPORT = /['"]\.\.\/\.\.\/\.\.\/((?:src|mobile)\/[^'"]+)['"]/g

/** A repo path handed to `importReleaseCheckoutModule`, inline or through a constant. */
const CHECKOUT_MODULE_PATH = /['"]\/?((?:src|mobile)\/[^'"\s]+\.tsx?)['"]/g

/** Floor for the paired modules found, so a scanner that stops matching cannot pass empty. */
const PAIRED_MODULE_FLOOR = 25

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

function resolveModule(specifier) {
  if (/\.tsx?$/.test(specifier)) {
    return specifier
  }
  const candidates = [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}/index.ts`]
  return candidates.find((path) => existsSync(join(projectDir, path))) ?? specifier
}

/**
 * Each module the suites load for pairing, with the first file that loads it. Only direct
 * loads: a module reached through one (the orchestration schema, via db.ts) is gated by hand.
 */
function readPairedModules() {
  const modules = new Map()
  for (const name of readdirSync(join(projectDir, LANE_DIRECTORY)).sort()) {
    if (!name.endsWith('.ts') || CHECKOUT_MACHINERY.has(name)) {
      continue
    }
    const source = readFileSync(join(projectDir, LANE_DIRECTORY, name), 'utf8')
    for (const pattern of [WORKING_TREE_IMPORT, CHECKOUT_MODULE_PATH]) {
      for (const [, specifier] of source.matchAll(pattern)) {
        const path = resolveModule(specifier)
        if (!modules.has(path)) {
          modules.set(path, name)
        }
      }
    }
  }
  return modules
}

const pairedModules = readPairedModules()

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

  it('keeps the unit shards excluding the directory, which is what makes this lane the only one', () => {
    const workflow = readWorkflow(UNIT_TEST_WORKFLOW)
    const shardStep = (workflow.jobs?.test?.steps ?? []).find(
      (step) => typeof step?.run === 'string' && step.run.includes('--shard=')
    )
    expect(shardStep, `no sharded vitest step in ${UNIT_TEST_WORKFLOW}`).toBeDefined()
    // If this exclusion is ever dropped the suites gain a second lane, and the argv stops
    // being the only thing that decides whether a file runs. Revisit this guard, do not
    // delete it: the shallow shard clone has no tags for an extracted release to skew against.
    // The shard applies UNIT_EXCLUDE only under this env flag; the lane's own run does not set it.
    expect(shardStep.env?.ORCA_BALANCE_UNIT_SHARDS).toBe('1')
    expect(UNIT_EXCLUDE).toContain(`${LANE_DIRECTORY}/**`)
  })

  it('runs the lane for a change to any suite it owns', () => {
    for (const path of suites) {
      expect(classifyPrJobs([path])[LANE_JOB], path).toBe(true)
    }
  })

  it('finds a plausible number of paired modules', () => {
    expect(
      pairedModules.size,
      `Only ${pairedModules.size} paired modules were recognized; the floor is ` +
        `${PAIRED_MODULE_FLOOR}. The scanner has probably stopped matching a load shape.`
    ).toBeGreaterThanOrEqual(PAIRED_MODULE_FLOOR)
  })

  it('pairs only modules that exist', () => {
    const missing = [...pairedModules]
      .filter(([path]) => !existsSync(join(projectDir, path)))
      .map(([path, loader]) => `${path} (loaded by ${loader})`)
    expect(missing).toEqual([])
  })

  it('runs the lane for a change to any module a suite pairs', () => {
    const ungated = [...pairedModules]
      .filter(([path]) => !classifyPrJobs([path])[LANE_JOB])
      .map(([path, loader]) => `${path} (loaded by ${loader})`)
    expect(ungated, 'add each to CROSS_VERSION_WIRE_PREFIXES in pr-code-change-scope.mjs').toEqual(
      []
    )
  })
})
