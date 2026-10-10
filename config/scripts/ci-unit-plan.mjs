import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { collectUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { FULL_SHARD_COUNT, planUnitSelection } from './ci-unit-selection.mjs'
import { readTimingBaseline, writeAssignment } from './ci-shard-assignment.mjs'

export function prepareUnitPlan(env = process.env) {
  const requestedCount = env.ORCA_UNIT_FULL_SHARD_COUNT ?? String(FULL_SHARD_COUNT)
  if (!['5', '10'].includes(requestedCount)) {
    throw new Error('ORCA_UNIT_FULL_SHARD_COUNT must be 5 or 10')
  }
  const fullShardCount = Number(requestedCount)
  const files = discoverUnitFiles()
  let plan
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
    if (env.GITHUB_EVENT_NAME !== 'pull_request') {
      throw new Error('Full reference run')
    }
    const diff = runProcessSync({
      program: 'git',
      args: ['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD'],
      maxOutputBytes: 16 * 1024 * 1024
    })
    if (diff.code !== 0 || diff.timedOut) {
      throw new Error('Changed paths unavailable')
    }
    plan = planUnitSelection({
      files,
      changed: diff.stdout.split('\0').filter(Boolean),
      graph: collectUnitDependencyGraph,
      timings: readTimingBaseline('unit').timings,
      event,
      mode: env.ORCA_UNIT_SELECTION_MODE,
      fullShardCount
    })
  } catch (error) {
    plan = {
      version: 1,
      mode: 'shadow',
      selectionAvailable: false,
      reason: String(error),
      files,
      candidateFiles: files,
      executionFiles: files,
      shards: Array.from({ length: fullShardCount }, (_, index) => ({
        index: index + 1,
        count: fullShardCount
      }))
    }
  }
  writeAssignment('ci-shards/unit-selection.json', plan)
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `shards=${JSON.stringify(plan.shards)}\n`)
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Unit selection: **${plan.mode}**; ${plan.candidateFiles.length}/${files.length} candidate files; ${plan.shards.length} execution shards. ${plan.reason}\n`
    )
  }
  return plan
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareUnitPlan()
}
