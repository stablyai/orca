import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import UnitTimingReporter from './ci-unit-timing-reporter.mjs'

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
  it('preserves timing evidence when optional output targets the timing file', () => {
    withReporterOutputs(({ timingPath }) => {
      const reporter = new UnitTimingReporter()
      reporter.onInit(phaseContext())
      const modules = [phaseModule('src/example.test.ts')]
      reporter.onTestRunEnd(modules, [], 'passed')
      const timing = readFileSync(timingPath, 'utf8')
      vi.stubEnv('ORCA_UNIT_PHASE_REPORT', timingPath)
      expect(() => reporter.onTestRunEnd(modules, [], 'passed')).not.toThrow()
      expect(readFileSync(timingPath, 'utf8')).toBe(timing)
    })
  })
})
