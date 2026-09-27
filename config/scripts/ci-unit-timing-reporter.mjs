import { relative } from 'node:path'
import { writeAssignment } from './ci-shard-assignment.mjs'

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
    writeAssignment(process.env.ORCA_UNIT_TIMING_REPORT ?? 'ci-shards/unit-timings.json', {
      metric: 'module-duration-v1',
      nodeVersion: process.versions.node,
      shard: this.ctx.config.shard ?? { index: 1, count: 1 },
      status: reason,
      unhandledErrors: errors.length,
      timings: Object.fromEntries(
        modules.map((module) => [
          relative(this.ctx.config.root, module.moduleId).replaceAll('\\', '/'),
          moduleDuration(module.diagnostic())
        ])
      )
    })
  }
}
