import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { importUnitTimingReports } from './ci-unit-timing-import.mjs'
import UnitTimingReporter, { moduleDuration } from './ci-unit-timing-reporter.mjs'

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
