import { relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { writeAssignment } from './ci-shard-assignment.mjs'
import { auditUnitSelection } from './ci-unit-selection.mjs'

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

  onTestRunEnd(modules, errors, reason) {
    const results = Object.fromEntries(
      modules.map((module) => [
        relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
        module.state?.() ?? 'unknown'
      ])
    )
    writeAssignment(process.env.ORCA_UNIT_TIMING_REPORT ?? 'ci-shards/unit-timings.json', {
      metric: 'module-duration-v1',
      nodeVersion: process.versions.node,
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
  }
}
