import { unitConsumers } from './ci-unit-dependency-graph.mjs'
import { balanceFiles } from './ci-shard-assignment.mjs'

export function selectUnitFiles(files, changed, graph) {
  const full = (reason) => ({ files, reason, full: true })
  if (!changed.length) {
    return full('Missing changed-path evidence')
  }
  if (changed.some((file) => !file.startsWith('src/') || !graph.files.has(file))) {
    return full('Global, deleted, renamed or unknown input')
  }
  for (const file of changed) {
    const consumers = unitConsumers([file], graph.reverse)
    if (!files.some((test) => consumers.has(test))) {
      return full('No proven test coverage for changed inputs')
    }
  }
  const affected = unitConsumers([...changed, ...graph.opaque], graph.reverse)
  const selected = files.filter((file) => affected.has(file))
  if (!selected.length) {
    return full('No proven test coverage for changed inputs')
  }
  return {
    files: selected,
    reason: 'Transitive imports plus indirect-input consumers',
    full: false
  }
}

export function planUnitSelection({ files, changed, graph, timings, event, mode = 'shadow' }) {
  const candidate = selectUnitFiles(files, changed, graph)
  const selected = mode === 'selected' && event?.pull_request?.draft === true && !candidate.full
  const executionFiles = selected ? candidate.files : files
  const totalMs = balanceFiles(executionFiles, 1, timings).shards[0].durationMs
  const count = selected
    ? Math.max(1, Math.min(8, Math.ceil(totalMs / 900_000), executionFiles.length))
    : 8
  return {
    version: 1,
    mode: selected ? 'selected' : 'shadow',
    selectionAvailable: !candidate.full,
    reason: candidate.reason,
    files,
    candidateFiles: candidate.files,
    executionFiles,
    shards: Array.from({ length: count }, (_, index) => ({ index: index + 1, count }))
  }
}

export function auditUnitSelection(plan, results) {
  const candidates = new Set(plan.candidateFiles)
  const omittedFailures = Object.entries(results)
    .filter(([file, state]) => state === 'failed' && !candidates.has(file))
    .map(([file]) => file)
  return {
    mode: plan.mode,
    discovered: plan.files.length,
    candidate: candidates.size,
    executed: Object.keys(results).length,
    omittedFailures
  }
}
