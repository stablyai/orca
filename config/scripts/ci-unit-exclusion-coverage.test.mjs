import { globSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { defaultExclude } from 'vitest/config'
import { describe, expect, it } from 'vitest'
import { CROSS_VERSION_WIRE_DIR, UNIT_INCLUDE, discoverUnitFiles } from './ci-unit-files.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

function posixPaths(files) {
  return files.map((file) => file.replaceAll('\\', '/'))
}

function workflowJobs(path) {
  return parse(readFileSync(path, 'utf8')).jobs
}

// Why verify.needs: a job left out of it (e2e, ime, wsl) can be red or skipped without blocking a merge.
// Each gating job carries the code_paths output that decides whether it runs; a called workflow's jobs inherit the caller's.
function gatingJobs() {
  const jobs = workflowJobs('.github/workflows/pr.yml')
  return jobs.verify.needs.flatMap((name) => {
    const { if: condition = '', uses } = jobs[name]
    const gate = /needs\.code_paths\.outputs\.([\w-]+) == 'true'/.exec(condition)?.[1]
    const called = uses?.startsWith('./.github/workflows/')
      ? Object.values(workflowJobs(uses.slice(2)))
      : [jobs[name]]
    return called.map((job) => ({ gate, pathArguments: vitestPathArguments(job) }))
  })
}

// Path arguments of every step in the job that runs vitest; a trailing slash means a directory.
function vitestPathArguments(job) {
  return (job.steps ?? [])
    .map((step) => step.run)
    .filter((run) => typeof run === 'string' && /\bvitest\b/.test(run))
    .flatMap((run) => run.replaceAll('\\\n', ' ').split(/\s+/))
    .map((token) => token.replace(/^['"]|['"]$/g, ''))
    .filter((token) => /^(?:src|config|tests|mobile)\//.test(token))
}

function runByVitestStep(file, pathArguments) {
  return pathArguments.some(
    (path) => path === file || (path.endsWith('/') && file.startsWith(path))
  )
}

// Why module scope: globbing the unit tree costs seconds, and every test reads the same result.
const UNIT_FILES = posixPaths(globSync(UNIT_INCLUDE, { exclude: defaultExclude }))
const SHARDED_UNIT_FILES = new Set(discoverUnitFiles())
const EXCLUDED_UNIT_FILES = UNIT_FILES.filter((file) => !SHARDED_UNIT_FILES.has(file))
const GATING_JOBS = gatingJobs()

describe('unit files kept out of the sharded test job', () => {
  it('each still runs in a job that gates the PR', () => {
    expect(EXCLUDED_UNIT_FILES.length).toBeGreaterThan(0)
    // Why: an excluded file no gating step names guards nothing, and nothing else reports it.
    expect(
      EXCLUDED_UNIT_FILES.filter(
        (file) => !GATING_JOBS.some((job) => runByVitestStep(file, job.pathArguments))
      )
    ).toEqual([])
  })

  it('a change to each runs a gating job that names it', () => {
    // Why: otherwise a PR editing only the file skips the one job that runs it.
    expect(
      EXCLUDED_UNIT_FILES.filter(
        (file) =>
          !GATING_JOBS.some(
            ({ gate, pathArguments }) =>
              runByVitestStep(file, pathArguments) && (!gate || classifyPrJobs([file])[gate])
          )
      )
    ).toEqual([])
  })

  it('runs the whole cross-version-wire directory, not a list of its files', () => {
    expect(GATING_JOBS.flatMap((job) => job.pathArguments)).toContain(CROSS_VERSION_WIRE_DIR)
  })

  it('names every cross-version-wire test so the unit include picks it up', () => {
    // Why: a directory argument only reaches files the vitest include matches; any other name is silently skipped.
    const tests = posixPaths(
      globSync(`${CROSS_VERSION_WIRE_DIR}**/*.{test,spec}.{js,cjs,mjs,ts,tsx}`)
    )
    const included = new Set(UNIT_FILES)
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.filter((file) => !included.has(file))).toEqual([])
  })
})
