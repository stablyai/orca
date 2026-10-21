import { relative } from 'node:path'
import { BaseSequencer } from 'vitest/node'
import { rankFilesByDuration, readTimingBaseline } from './ci-shard-assignment.mjs'

export default class RuntimeSequencer extends BaseSequencer {
  constructor(ctx, timingBaseline = undefined) {
    super(ctx)
    this.timingBaseline = timingBaseline
  }

  async sort(specifications) {
    const inherited = await super.sort(specifications)
    if (new Set(inherited.map((spec) => spec.project.name)).size < 2) {
      return inherited
    }
    // Start long contracts across both runtimes instead of leaving Node until the end.
    const baseline = this.timingBaseline ?? readTimingBaseline('unit')
    const key = (spec) => relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
    const { weighted } = rankFilesByDuration(
      [...new Set(inherited.map(key))],
      baseline.timings,
      baseline.overheadMs
    )
    const ranks = new Map(weighted.map(({ file }, index) => [file, index]))
    return inherited.sort((a, b) => {
      const groupOrder = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder
      const isolationOrder = Number(b.project.config.isolate) - Number(a.project.config.isolate)
      return groupOrder || isolationOrder || ranks.get(key(a)) - ranks.get(key(b))
    })
  }
}
