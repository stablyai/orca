import { appendFileSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function reviewUnitSelection(records) {
  const groups = new Map()
  for (const { plan, timing } of records) {
    const key = JSON.stringify([
      timing.sourceSha,
      timing.runId,
      timing.runAttempt,
      timing.nodeVersion
    ])
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push({ plan, timing })
  }
  return [...groups.values()].map((group) => {
    const { plan, timing: first } = group[0]
    const selected = new Set(plan.candidateFiles)
    const files = new Set()
    const shards = new Set()
    const missedFailures = []
    let invalid = false
    let omittedMs = 0
    let totalMs = 0
    for (const { plan: other, timing } of group) {
      invalid ||=
        JSON.stringify(other) !== JSON.stringify(plan) ||
        !first.sourceSha ||
        plan.sourceSha !== first.sourceSha ||
        timing.unhandledErrors !== 0 ||
        !['passed', 'failed'].includes(timing.status) ||
        timing.shard.count !== first.shard.count ||
        shards.has(timing.shard.index) ||
        timing.shard.index < 1 ||
        timing.shard.index > first.shard.count
      shards.add(timing.shard.index)
      for (const [file, duration] of Object.entries(timing.timings)) {
        invalid ||=
          files.has(file) ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          !['passed', 'failed', 'skipped'].includes(timing.results?.[file])
        files.add(file)
        totalMs += duration
        if (!selected.has(file)) {
          omittedMs += duration
          if (timing.results?.[file] === 'failed') {
            missedFailures.push(file)
          }
        }
      }
    }
    const complete =
      !invalid &&
      shards.size === first.shard.count &&
      JSON.stringify([...files].sort()) === JSON.stringify([...plan.files].sort())
    return {
      sourceSha: first.sourceSha,
      runId: first.runId,
      runAttempt: first.runAttempt,
      nodeVersion: first.nodeVersion,
      mode: plan.mode,
      completeFullRun: complete && plan.mode === 'shadow',
      selectionEvaluated: complete && plan.mode === 'shadow' && plan.selectionAvailable === true,
      reason: plan.reason,
      missedFailures,
      files: files.size,
      candidateFiles: selected.size,
      measuredWorkerMs: totalMs,
      potentiallyOmittedWorkerMs: omittedMs
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2]
  if (!directory) {
    throw new Error('Usage: ci-unit-selection-review.mjs ARTIFACT_DIRECTORY')
  }
  const records = globSync('**/unit-timings.json', { cwd: directory }).map((file) => {
    const timing = JSON.parse(readFileSync(join(directory, file), 'utf8'))
    const plan = JSON.parse(
      readFileSync(
        join(directory, file.replace('unit-timings.json', 'unit-selection.json')),
        'utf8'
      )
    )
    return { timing, plan }
  })
  if (!records.length) {
    throw new Error('No unit selection evidence')
  }
  const review = reviewUnitSelection(records)
  writeFileSync(join(directory, 'selection-review.json'), `${JSON.stringify(review, null, 2)}\n`)
  const summary = [
    '## Unit selection evidence',
    '',
    ...review.map(
      (row) =>
        `- Node ${row.nodeVersion}: ${row.completeFullRun ? 'complete full reference' : 'incomplete or selected evidence'}; ${row.selectionEvaluated ? 'selection evaluated' : 'not selection-validation evidence'}; ${row.candidateFiles}/${row.files} candidate files; ${row.missedFailures.length} failures outside selection; ${(row.potentiallyOmittedWorkerMs / 60_000).toFixed(1)} potentially omitted worker-minutes. ${row.reason ?? ''}`
    ),
    '',
    'Worker time overlaps across processes; it is not runner time. Promote only after representative complete references show no missed failures.',
    ''
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }
  console.log(summary)
}
