import type { SessionSearchStore } from './storage/session-search-store'
import type { SessionSearchReadPreparation } from './session-search-catalog-candidate-types'

export function prepareSessionSearchRead(
  store: SessionSearchStore,
  path: string,
  agent: string | null | undefined,
  expected: SessionSearchReadPreparation
) {
  const queue = store.catalogWork
  const candidates = store.catalogCandidates
  const catalog = store.catalogStorage
  return catalog.transaction('search_read_preparation', () => {
    const result = candidates.execute({ kind: 'batch', rows: [] })
    const work = queue.get(path)
    const current = { size: queue.size, left: queue.left, revision: queue.revision }
    if (
      expected.revision !== queue.revision ||
      !work ||
      work.version !== expected.version ||
      work.root !== expected.root ||
      work.candidate.agent !== agent ||
      !queue.matches({ ...work, receipt: expected.receipt })
    ) {
      return { ...result, work: current }
    }
    const observation = expected.observation
    if (!observation) {
      return { ...result, readRoot: work.root, work: { ...current, work } }
    }
    if (
      observation.input.path !== path ||
      !observation.input.requireMembership ||
      !observation.scope.startsWith(`physical:${agent}:`)
    ) {
      throw new Error('Session read preparation has no matching physical owner')
    }
    const prepared = catalog.response({
      kind: 'observe-prepare',
      scope: observation.scope,
      generation: observation.generation,
      inputs: [observation.input]
    })
    return {
      ...result,
      readRoot: work.root,
      work: { ...current, work },
      preparedRead: prepared.prepared?.[0],
      scopeCounts: prepared.scopeCounts
    }
  })
}
