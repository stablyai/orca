import { relative, resolve } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { writeAssignment } from './ci-shard-assignment.mjs'
import { auditUnitSelection } from './ci-unit-selection.mjs'

export const UNIT_PHASE_FILE_LIMIT = 50_000
const phaseNames = [
  'environmentSetupDuration',
  'prepareDuration',
  'collectDuration',
  'setupDuration',
  'duration'
]

const nonnegativeNumber = (value) => (Number.isFinite(value) && value >= 0 ? value : null)
const emptyPhases = () => Object.fromEntries(phaseNames.map((name) => [name, 0]))
const emptyImportSample = () => ({ entries: 0, selfTimeMs: 0, totalTimeMs: 0 })
const workerCounters = (state) => ({
  workersSpawned: Number.isInteger(state?.workersSpawned)
    ? nonnegativeNumber(state.workersSpawned)
    : null,
  startupTimeMs: nonnegativeNumber(state?.startupTime)
})

export function buildUnitPhaseReport(ctx, modules, errors, reason, baseline) {
  const files = []
  const projects = new Map()
  const totals = emptyPhases()
  const phaseSamples = emptyPhases()
  for (const module of modules) {
    const diagnostic = module.diagnostic()
    const project = module.project?.name ?? 'unknown'
    if (!projects.has(project)) {
      projects.set(project, {
        project,
        files: 0,
        phases: emptyPhases(),
        phaseSamples: emptyPhases(),
        sampledImports: emptyImportSample()
      })
    }
    const aggregate = projects.get(project)
    aggregate.files += 1
    const phases = {}
    for (const name of phaseNames) {
      const value = nonnegativeNumber(diagnostic?.[name])
      phases[name] = value
      if (value !== null) {
        aggregate.phases[name] += value
        aggregate.phaseSamples[name] += 1
        totals[name] += value
        phaseSamples[name] += 1
      }
    }
    const imports = diagnostic?.importDurations
    if (imports && typeof imports === 'object') {
      for (const id in imports) {
        if (!Object.hasOwn(imports, id)) {
          continue
        }
        const selfTime = nonnegativeNumber(imports[id]?.selfTime)
        const totalTime = nonnegativeNumber(imports[id]?.totalTime)
        if (selfTime !== null && totalTime !== null) {
          aggregate.sampledImports.entries += 1
          aggregate.sampledImports.selfTimeMs += selfTime
          aggregate.sampledImports.totalTimeMs += totalTime
        }
      }
    }
    if (files.length < UNIT_PHASE_FILE_LIMIT) {
      files.push({
        file: relative(ctx.config.root, module.moduleId).replaceAll('\\', '/'),
        project,
        workerId: nonnegativeNumber(diagnostic?.workerId),
        concurrencyId: nonnegativeNumber(diagnostic?.concurrencyId),
        phases
      })
    }
  }
  const counters = workerCounters(ctx.state)
  return {
    metric: 'module-phase-diagnostics-v1',
    nodeVersion: process.env.ORCA_TEST_NODE_VERSION ?? process.versions.node,
    ...(process.versions.bun ? { bunVersion: process.versions.bun } : {}),
    vitestVersion: ctx.version ?? null,
    shard: ctx.config.shard ?? { index: 1, count: 1 },
    status: reason,
    unhandledErrors: errors.length,
    units: 'milliseconds',
    phaseTime: 'summed-worker-time',
    fileLimit: UNIT_PHASE_FILE_LIMIT,
    filesSeen: modules.length,
    filesOmitted: modules.length - files.length,
    workerTotals: {
      scope: baseline ? 'test-run' : 'vitest-session',
      ...Object.fromEntries(
        Object.entries(counters).map(([name, value]) => [
          name,
          value === null || (baseline && baseline[name] === null)
            ? null
            : nonnegativeNumber(value - (baseline?.[name] ?? 0))
        ])
      )
    },
    phases: totals,
    phaseSamples,
    projects: [...projects.values()],
    files
  }
}

export function moduleDuration(diagnostic) {
  return Math.max(
    1,
    Math.ceil(
      diagnostic.environmentSetupDuration +
        diagnostic.prepareDuration +
        diagnostic.collectDuration +
        diagnostic.setupDuration +
        diagnostic.duration
    )
  )
}

export default class UnitTimingReporter {
  onInit(ctx) {
    this.ctx = ctx
  }

  onTestRunStart() {
    if (process.env.ORCA_UNIT_PHASE_REPORT) {
      this.workerBaseline = workerCounters(this.ctx.state)
    }
  }

  onTestRunEnd(modules, errors, reason) {
    const results = Object.fromEntries(
      modules.map((module) => [
        relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
        module.state?.() ?? 'unknown'
      ])
    )
    writeAssignment(process.env.ORCA_UNIT_TIMING_REPORT ?? 'ci-shards/unit-timings.json', {
      metric: 'module-duration-v1',
      nodeVersion: process.env.ORCA_TEST_NODE_VERSION ?? process.versions.node,
      ...(process.versions.bun ? { bunVersion: process.versions.bun } : {}),
      shard: this.ctx.config.shard ?? { index: 1, count: 1 },
      status: reason,
      unhandledErrors: errors.length,
      results,
      timings: Object.fromEntries(
        modules.map((module) => [
          relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
          moduleDuration(module.diagnostic())
        ])
      )
    })
    try {
      const plan = JSON.parse(
        readFileSync(
          process.env.ORCA_UNIT_SELECTION_PLAN ?? 'ci-shards/unit-selection.json',
          'utf8'
        )
      )
      const audit = auditUnitSelection(plan, results)
      writeAssignment('ci-shards/unit-selection-audit.json', audit)
      if (process.env.GITHUB_STEP_SUMMARY) {
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Unit selection (${audit.mode}): ${audit.candidate}/${audit.discovered} candidate files; ${audit.omittedFailures.length} failures outside selection.\n`
        )
      }
    } catch {
      // Timing evidence remains useful when selection planning was unavailable.
    }
    const phaseReport = process.env.ORCA_UNIT_PHASE_REPORT
    const timingReport = process.env.ORCA_UNIT_TIMING_REPORT ?? 'ci-shards/unit-timings.json'
    if (phaseReport && resolve(phaseReport) !== resolve(timingReport)) {
      try {
        writeAssignment(
          phaseReport,
          buildUnitPhaseReport(this.ctx, modules, errors, reason, this.workerBaseline)
        )
      } catch {
        // Optional diagnostics must not change the test verdict.
      }
    }
  }
}
