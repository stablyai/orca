import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { collectUnitDependencyGraph } from './dependency-graph/ci-unit-dependency-graph.mjs'
import { discoverUnitFiles } from './dependency-graph/ci-unit-files.mjs'
import { planUnitSelection } from './ci-unit-selection.mjs'
import { fullUnitMatrix } from './ci-unit-matrix.mjs'
import { readTimingBaseline, writeAssignment } from '../sharding/ci-shard-assignment.mjs'

export function prepareUnitPlan(env = process.env) {
  const shards = fullUnitMatrix(env.ORCA_UNIT_FULL_SHARD_COUNT)
  const fullShardCount = shards.length
  const files = discoverUnitFiles()
  let plan
  try {
    // From the workflow, not the payload file: background steps can read it mid-rewrite.
    const event = { pull_request: { draft: env.ORCA_PULL_REQUEST_DRAFT === 'true' } }
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
      shards
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
