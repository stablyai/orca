import type {
  ClaudeUsageParseResumeState,
  ClaudeUsagePersistedFile,
  ClaudeUsageTokenMaxima,
  ClaudeUsageTokenTotals,
  ClaudeUsageTurnProjection
} from './types'

export type ClaudeUsageTokenCorrection = {
  previous: Readonly<ClaudeUsageTokenMaxima>
  updated: Readonly<ClaudeUsageTokenMaxima>
  projection: ClaudeUsageTurnProjection | null
}

type ClaudeUsageTokenCheckpoint = {
  ownedDedupeKeys: string[]
  find: (key: string) => Readonly<ClaudeUsageTokenMaxima> | undefined
  increase: (key: string, turn: ClaudeUsageTokenTotals) => ClaudeUsageTokenCorrection | null
  append: (
    key: string,
    turn: ClaudeUsageTokenTotals,
    projection: ClaudeUsageTurnProjection | null
  ) => void
  finish: () => Pick<ClaudeUsageParseResumeState, 'ownedTokenMaxima' | 'projections'>
}

function projectionKey(projection: ClaudeUsageTurnProjection): string {
  return JSON.stringify([
    projection.sessionId,
    projection.day,
    projection.model,
    projection.projectKey
  ])
}

export function createClaudeUsageTokenCheckpoint(
  previous?: ClaudeUsagePersistedFile
): ClaudeUsageTokenCheckpoint {
  const state = previous?.parseResumeState
  const ownedDedupeKeys = state && previous ? [...previous.ownedDedupeKeys] : []
  const ownedTokenMaxima = [...(state?.ownedTokenMaxima ?? [])]
  const projections = [...(state?.projections ?? [])]
  const indexByKey = new Map<string, number>()
  const projectionIndex = new Map<string, number>()
  if (ownedDedupeKeys.length !== ownedTokenMaxima.length) {
    throw new Error('Claude usage token checkpoint is missing a key or projection.')
  }
  for (let index = 0; index < ownedDedupeKeys.length; index++) {
    const key = ownedDedupeKeys[index]
    const row = ownedTokenMaxima[index]
    if (typeof key !== 'string' || !row || (row[5] !== null && !projections[row[5]])) {
      throw new Error('Claude usage token checkpoint is missing a key or projection.')
    }
    indexByKey.set(key, index)
  }
  for (let index = 0; index < projections.length; index++) {
    projectionIndex.set(projectionKey(projections[index]), index)
  }

  return {
    ownedDedupeKeys,
    find(key) {
      const index = indexByKey.get(key)
      return index === undefined ? undefined : ownedTokenMaxima[index]
    },
    increase(key, turn) {
      const index = indexByKey.get(key)
      const row = index === undefined ? undefined : ownedTokenMaxima[index]
      if (index === undefined || !row) {
        throw new Error('Claude usage token checkpoint is missing an owned turn.')
      }
      const input = Math.max(row[0], turn.inputTokens)
      const output = Math.max(row[1], turn.outputTokens)
      const read = Math.max(row[2], turn.cacheReadTokens)
      const write = Math.max(row[3], turn.cacheWriteTokens)
      const write1h = Math.max(row[4], turn.cacheWrite1hTokens)
      if (
        input === row[0] &&
        output === row[1] &&
        read === row[2] &&
        write === row[3] &&
        write1h === row[4]
      ) {
        return null
      }
      const updated: ClaudeUsageTokenMaxima = [input, output, read, write, write1h, row[5]]
      ownedTokenMaxima[index] = updated
      return {
        previous: row,
        updated,
        projection: row[5] === null ? null : projections[row[5]]
      }
    },
    append(key, turn, projection) {
      let routeIndex: number | null = null
      if (projection) {
        const routeKey = projectionKey(projection)
        routeIndex = projectionIndex.get(routeKey) ?? null
        if (routeIndex === null) {
          routeIndex = projections.length
          projectionIndex.set(routeKey, routeIndex)
          projections.push(projection)
        }
      }
      const row: ClaudeUsageTokenMaxima = [
        turn.inputTokens,
        turn.outputTokens,
        turn.cacheReadTokens,
        turn.cacheWriteTokens,
        turn.cacheWrite1hTokens,
        routeIndex
      ]
      const index = indexByKey.get(key)
      if (index === undefined) {
        indexByKey.set(key, ownedDedupeKeys.length)
        ownedDedupeKeys.push(key)
        ownedTokenMaxima.push(row)
      } else {
        ownedTokenMaxima[index] = row
      }
    },
    finish: () => ({ ownedTokenMaxima, projections })
  }
}
