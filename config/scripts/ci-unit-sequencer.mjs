import { relative } from 'node:path'
import { readFileSync } from 'node:fs'
import { BaseSequencer } from 'vitest/node'
import { balanceFiles, readTimingBaseline, writeAssignment } from './ci-shard-assignment.mjs'

export default class TimingSequencer extends BaseSequencer {
  async shard(specs) {
    const { index, count } = this.ctx.config.shard
    const key = (spec) => relative(this.ctx.config.root, spec.moduleId).replaceAll('\\', '/')
    let execution = specs
    let selectionReason = 'Full suite: no verified selection plan'
    try {
      const plan = JSON.parse(
        readFileSync(
          process.env.ORCA_UNIT_SELECTION_PLAN ?? 'ci-shards/unit-selection.json',
          'utf8'
        )
      )
      const discovered = new Set(plan.files)
      if (
        plan.version !== 1 ||
        !plan.sourceSha ||
        plan.sourceSha !== process.env.ORCA_SHARD_SOURCE_SHA ||
        JSON.stringify([...plan.files].sort()) !== JSON.stringify(specs.map(key).sort()) ||
        !Array.isArray(plan.executionFiles) ||
        plan.executionFiles.some((file) => !discovered.has(file))
      ) {
        throw new Error('Selection provenance or discovery differs')
      }
      const allowed = new Set(plan.executionFiles)
      if (allowed.size === 0) {
        throw new Error('Empty execution selection')
      }
      execution = specs.filter((spec) => allowed.has(key(spec)))
      selectionReason = plan.reason
    } catch (error) {
      console.log(`Running every discovered unit test: ${error.message}`)
    }
    const baseline = readTimingBaseline('unit')
    const assignment = balanceFiles(
      execution.map(key),
      count,
      baseline.timings,
      baseline.overheadMs
    )
    writeAssignment(process.env.ORCA_SHARD_MANIFEST ?? 'ci-shards/unit-assignment.json', {
      ...assignment,
      baselineSha256: baseline.baselineSha256,
      selectedShard: index,
      selectionReason
    })
    const selected = new Set(assignment.shards[index - 1].files)
    return specs.filter((spec) => selected.has(key(spec)))
  }
}
