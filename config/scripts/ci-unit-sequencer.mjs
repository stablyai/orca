import { relative } from 'node:path'
import { BaseSequencer } from 'vitest/node'
import { balanceFiles, readTimingBaseline, writeAssignment } from './ci-shard-assignment.mjs'

export default class TimingSequencer extends BaseSequencer {
  async shard(specs) {
    const { index, count } = this.ctx.config.shard
    const key = (spec) => relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
    const baseline = readTimingBaseline('unit')
    const assignment = balanceFiles(specs.map(key), count, baseline.timings, baseline.overheadMs)
    writeAssignment(process.env.ORCA_SHARD_MANIFEST ?? 'ci-shards/unit-assignment.json', {
      ...assignment,
      baselineSha256: baseline.baselineSha256,
      selectedShard: index
    })
    const selected = new Set(assignment.shards[index - 1].files)
    return specs.filter((spec) => selected.has(key(spec)))
  }
}
