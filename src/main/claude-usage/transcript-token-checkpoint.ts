import type {
  ClaudeUsageOwnedTurn,
  ClaudeUsageParseResumeState,
  ClaudeUsagePersistedFile,
  ClaudeUsageTokenMaxima,
  ClaudeUsageTurnProjection
} from './types'

export function hydrateClaudeUsageOwnedTurns(
  previous: ClaudeUsagePersistedFile | undefined
): Map<string, ClaudeUsageOwnedTurn> {
  const state = previous?.parseResumeState
  const turns = new Map<string, ClaudeUsageOwnedTurn>()
  if (!state || !previous) {
    return turns
  }
  for (const [index, row] of state.ownedTokenMaxima.entries()) {
    const key = previous.ownedDedupeKeys[index]
    const projection = row[5] === null ? null : state.projections[row[5]]
    if (typeof key !== 'string' || projection === undefined) {
      throw new Error('Claude usage token checkpoint is missing a key or projection.')
    }
    turns.set(key, {
      dedupeKey: key,
      inputTokens: row[0],
      outputTokens: row[1],
      cacheReadTokens: row[2],
      cacheWriteTokens: row[3],
      cacheWrite1hTokens: row[4],
      projection
    })
  }
  return turns
}

export function encodeClaudeUsageTokenCheckpoint(
  turns: Map<string, ClaudeUsageOwnedTurn>
): Pick<ClaudeUsageParseResumeState, 'ownedTokenMaxima' | 'projections'> {
  const projectionIndex = new Map<string, number>()
  const projections: ClaudeUsageTurnProjection[] = []
  const ownedTokenMaxima: ClaudeUsageTokenMaxima[] = []
  // Tuple positions follow ownedDedupeKeys; repeated first-row routing is stored once.
  for (const turn of turns.values()) {
    let index: number | null = null
    if (turn.projection) {
      const projection = turn.projection
      const key = JSON.stringify([
        projection.sessionId,
        projection.day,
        projection.model,
        projection.projectKey
      ])
      index = projectionIndex.get(key) ?? null
      if (index === null) {
        index = projections.length
        projectionIndex.set(key, index)
        projections.push(projection)
      }
    }
    ownedTokenMaxima.push([
      turn.inputTokens,
      turn.outputTokens,
      turn.cacheReadTokens,
      turn.cacheWriteTokens,
      turn.cacheWrite1hTokens,
      index
    ])
  }
  return { ownedTokenMaxima, projections }
}
