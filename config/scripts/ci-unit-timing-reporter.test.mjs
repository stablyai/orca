import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { importUnitTimingReports } from './ci-unit-timing-import.mjs'
import UnitTimingReporter, {
  buildUnitPhaseReport,
  moduleDuration,
  UNIT_PHASE_FILE_LIMIT
} from './ci-unit-timing-reporter.mjs'

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
  it('counts each worker phase once, including imports of tests with cheap assertions', () => {
    expect(
      moduleDuration({
        environmentSetupDuration: 11,
        prepareDuration: 12,
        collectDuration: 130,
        setupDuration: 14,
        duration: 0.2,
        importDurations: { dependency: 100 }
      })
    ).toBe(168)
  })

  it.each([undefined, '24.21.0', '26.6.0'])(
    'writes reporter provenance for selected Node version %s',
    (nodeVersion) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-unit-timing-'))
      const previous = process.env.ORCA_UNIT_TIMING_REPORT
      process.env.ORCA_UNIT_TIMING_REPORT = join(directory, 'unit-timings.json')
      vi.stubEnv('ORCA_TEST_NODE_VERSION', nodeVersion)
      vi.stubEnv('ORCA_UNIT_PHASE_REPORT', undefined)
      try {
        const reporter = new UnitTimingReporter()
        reporter.onInit({ config: { root: process.cwd(), shard: { index: 1, count: 8 } } })
        reporter.onTestRunEnd(
          [
            {
              moduleId: resolve('src/example.test.ts'),
              diagnostic: () => ({
                environmentSetupDuration: 0,
                prepareDuration: 0,
                collectDuration: 200,
                setupDuration: 10,
                duration: 5
              })
            }
          ],
          [],
          'passed'
        )
        expect(JSON.parse(readFileSync(process.env.ORCA_UNIT_TIMING_REPORT, 'utf8'))).toMatchObject(
          {
            metric: 'module-duration-v1',
            nodeVersion: nodeVersion ?? process.versions.node,
            ...(process.versions.bun ? { bunVersion: process.versions.bun } : {}),
            shard: { index: 1, count: 8 },
            status: 'passed',
            unhandledErrors: 0,
            timings: { 'src/example.test.ts': 215 }
          }
        )
      } finally {
        vi.unstubAllEnvs()
        if (previous === undefined) {
          delete process.env.ORCA_UNIT_TIMING_REPORT
        } else {
          process.env.ORCA_UNIT_TIMING_REPORT = previous
        }
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('imports all shards without adding the old average overhead again', () => {
    expect(importUnitTimingReports([report(2, { b: 100 }), report(1, { a: 200 })])).toMatchObject({
      sourceSha: 'source',
      overheadMs: 0,
      metric: 'module-duration-v1',
      timings: { a: 200, b: 100 }
    })
  })

  it('preserves Bun provenance and rejects mixing Bun and Node timing sets', () => {
    const first = { ...report(1, { a: 100 }), bunVersion: '1.4.2' }
    const second = { ...report(2, { b: 200 }), bunVersion: '1.4.2' }
    expect(importUnitTimingReports([first, second])).toMatchObject({ bunVersion: '1.4.2' })
    expect(() => importUnitTimingReports([first, report(2, { b: 200 })])).toThrow('successful')
    expect(() => importUnitTimingReports([first, { ...second, bunVersion: '1.4.1' }])).toThrow(
      'successful'
    )
  })

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
  it('leaves the timing report identical and writes nothing extra when disabled', () => {
    withReporterOutputs(({ timingPath, phasePath }) => {
      const modules = [
        phaseModule(
          'src/example.test.ts',
          phaseDiagnostic({ importDurations: { dependency: { selfTime: 100, totalTime: 200 } } })
        )
      ]
      const reporter = new UnitTimingReporter()
      reporter.onInit(phaseContext({ workersSpawned: 3, startupTime: 500 }))
      reporter.onTestRunEnd(modules, [], 'passed')
      const timing = readFileSync(timingPath, 'utf8')
      expect(existsSync(phasePath)).toBe(false)

      vi.stubEnv('ORCA_UNIT_PHASE_REPORT', phasePath)
      reporter.onTestRunEnd(modules, [], 'passed')
      expect(readFileSync(timingPath, 'utf8')).toBe(timing)
      expect(JSON.parse(timing).timings).toEqual({ 'src/example.test.ts': 44 })
      expect(JSON.parse(readFileSync(phasePath, 'utf8'))).toMatchObject({
        sourceSha: 'phase-source',
        runId: 'phase-run',
        runAttempt: '3',
        metric: 'module-phase-diagnostics-v1',
        vitestVersion: '5.0.3',
        shard: { index: 1, count: 5 },
        status: 'passed',
        unhandledErrors: 0,
        workerTotals: { scope: 'vitest-session', workersSpawned: 3, startupTimeMs: 500 }
      })
    })
  })

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

  it('reports successful worker startup counters for the current run separately', () => {
    withReporterOutputs(({ phasePath }) => {
      vi.stubEnv('ORCA_UNIT_PHASE_REPORT', phasePath)
      const state = { workersSpawned: 2, startupTime: 10 }
      const reporter = new UnitTimingReporter()
      reporter.onInit(phaseContext(state))
      reporter.onTestRunStart()
      state.workersSpawned = 5
      state.startupTime = 60.25
      reporter.onTestRunEnd([phaseModule('src/example.test.ts')], [], 'passed')
      expect(JSON.parse(readFileSync(phasePath, 'utf8')).workerTotals).toEqual({
        scope: 'test-run',
        workersSpawned: 3,
        startupTimeMs: 50.25
      })
    })
  })

  it('caps file detail while keeping aggregates from omitted files', () => {
    const module = phaseModule('src/repeated.test.ts')
    const modules = Array.from({ length: UNIT_PHASE_FILE_LIMIT }, () => module)
    modules.push(
      phaseModule(
        'src/omitted.test.ts',
        phaseDiagnostic({
          collectDuration: 11,
          importDurations: { dependency: { selfTime: 2, totalTime: 3 } }
        })
      )
    )
    const report = buildUnitPhaseReport(phaseContext(), modules, [], 'passed')
    expect(report.files).toHaveLength(UNIT_PHASE_FILE_LIMIT)
    expect(report).toMatchObject({
      fileLimit: UNIT_PHASE_FILE_LIMIT,
      filesSeen: UNIT_PHASE_FILE_LIMIT + 1,
      filesOmitted: 1,
      phases: { collectDuration: UNIT_PHASE_FILE_LIMIT * 30.25 + 11 },
      projects: [
        {
          files: UNIT_PHASE_FILE_LIMIT + 1,
          sampledImports: { entries: 1, selfTimeMs: 2, totalTimeMs: 3 }
        }
      ]
    })
  })

  it('marks unavailable counters, phases and worker IDs without inventing measurements', () => {
    const report = buildUnitPhaseReport(
      phaseContext({ workersSpawned: -1, startupTime: Number.NaN }),
      [phaseModule('src/unavailable.test.ts', {})],
      [],
      'interrupted'
    )
    expect(report.workerTotals).toEqual({
      scope: 'vitest-session',
      workersSpawned: null,
      startupTimeMs: null
    })
    expect(report.files[0]).toMatchObject({
      workerId: null,
      concurrencyId: null,
      phases: { collectDuration: null }
    })
    expect(report.phaseSamples.collectDuration).toBe(0)
    expect(report.status).toBe('interrupted')
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
