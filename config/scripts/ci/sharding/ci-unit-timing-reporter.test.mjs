import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { importUnitTimingReports } from './ci-unit-timing-import.mjs'
import UnitTimingReporter, { buildUnitPhaseReport } from './ci-unit-timing-reporter.mjs'

const report = (index, timings) => ({
  metric: 'module-duration-v1',
  nodeVersion: '24.21.0',
  sourceSha: 'source',
  runId: 'run',
  runAttempt: '1',
  shard: { index, count: 2 },
  status: 'passed',
  unhandledErrors: 0,
  timings
})

describe('unit worker timing evidence', () => {
  it('rejects incomplete, duplicate, mixed and failed evidence', () => {
    const first = report(1, { a: 100 })
    expect(() => importUnitTimingReports([first])).toThrow('complete')
    expect(() => importUnitTimingReports([first, first])).toThrow('index')
    expect(() => importUnitTimingReports([first, report(2, { a: 200 })])).toThrow('timing')
    for (const change of [
      { sourceSha: 'other' },
      { runId: 'other' },
      { runAttempt: '2' },
      { nodeVersion: '26.6.0' },
      { metric: 'test-duration' },
      { status: 'failed' },
      { status: 'interrupted' },
      { unhandledErrors: 1 }
    ]) {
      expect(() =>
        importUnitTimingReports([first, { ...report(2, { b: 200 }), ...change }])
      ).toThrow('successful')
    }
    expect(() => importUnitTimingReports([first, report(2, { b: -1 })])).toThrow('timing')
  })
})

const phaseDiagnostic = (overrides = {}) => ({
  environmentSetupDuration: 1.5,
  prepareDuration: 2.5,
  collectDuration: 30.25,
  setupDuration: 4.5,
  duration: 5.25,
  workerId: 7,
  concurrencyId: 2,
  importDurations: {},
  ...overrides
})
const phaseModule = (file, diagnostic = phaseDiagnostic(), project = 'bun') => ({
  moduleId: resolve(file),
  project: { name: project },
  state: () => 'passed',
  diagnostic: () => diagnostic
})
const phaseContext = (state) => ({
  config: { root: process.cwd(), shard: { index: 1, count: 5 } },
  version: '5.0.3',
  state
})

function withReporterOutputs(run) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-unit-phases-'))
  const timingPath = join(directory, 'unit-timings.json')
  const phasePath = join(directory, 'unit-phase-diagnostics.json')
  vi.stubEnv('ORCA_UNIT_TIMING_REPORT', timingPath)
  vi.stubEnv('ORCA_UNIT_PHASE_REPORT', undefined)
  vi.stubEnv('ORCA_UNIT_SELECTION_PLAN', join(directory, 'missing-selection.json'))
  vi.stubEnv('ORCA_SHARD_SOURCE_SHA', 'phase-source')
  vi.stubEnv('GITHUB_RUN_ID', 'phase-run')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '3')
  try {
    run({ timingPath, phasePath })
  } finally {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('optional unit phase diagnostics', () => {
  it('records fractions and project totals without retaining sampled import records', () => {
    const report = buildUnitPhaseReport(
      phaseContext(),
      [
        phaseModule(
          'src/first.test.ts',
          phaseDiagnostic({
            importDurations: {
              first: { selfTime: 2, totalTime: 9, importer: 'src/private-account.ts' },
              second: { selfTime: 3.5, totalTime: 5.5 },
              invalid: { selfTime: Number.NaN, totalTime: 4 }
            }
          })
        ),
        phaseModule('src/second.test.ts'),
        phaseModule('src/node.test.ts', phaseDiagnostic({ workerId: 9 }), 'node-runtime')
      ],
      [{ message: 'test error' }],
      'failed'
    )
    expect(report.files[0]).toEqual({
      file: 'src/first.test.ts',
      project: 'bun',
      workerId: 7,
      concurrencyId: 2,
      phases: {
        environmentSetupDuration: 1.5,
        prepareDuration: 2.5,
        collectDuration: 30.25,
        setupDuration: 4.5,
        duration: 5.25
      }
    })
    expect(report.projects).toMatchObject([
      {
        project: 'bun',
        files: 2,
        phases: { collectDuration: 60.5 },
        phaseSamples: { collectDuration: 2 },
        sampledImports: { entries: 2, selfTimeMs: 5.5, totalTimeMs: 14.5 }
      },
      { project: 'node-runtime', files: 1, sampledImports: { entries: 0 } }
    ])
    expect(report.phases.collectDuration).toBe(90.75)
    expect(report).toMatchObject({
      phaseTime: 'summed-worker-time',
      status: 'failed',
      unhandledErrors: 1
    })
    expect(JSON.stringify(report)).not.toContain('private-account')
    expect(JSON.stringify(report)).not.toContain('importDurations')
  })

  it.each(['unwritable', 'same as timing'])(
    'preserves timing evidence when the optional output is %s',
    (target) => {
      withReporterOutputs(({ timingPath }) => {
        const reporter = new UnitTimingReporter()
        reporter.onInit(phaseContext())
        const modules = [phaseModule('src/example.test.ts')]
        reporter.onTestRunEnd(modules, [], 'passed')
        const timing = readFileSync(timingPath, 'utf8')
        vi.stubEnv(
          'ORCA_UNIT_PHASE_REPORT',
          target === 'unwritable' ? `${timingPath}/unwritable.json` : timingPath
        )
        expect(() => reporter.onTestRunEnd(modules, [], 'passed')).not.toThrow()
        expect(readFileSync(timingPath, 'utf8')).toBe(timing)
      })
    }
  )
})
