// `orca worktree ps --since <age>`: only the workspaces touched recently, newest first, so a long list
// doesn't flood whoever reads it.
import type { RuntimeWorktreePsResult } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { RuntimeClientError } from '../runtime/connection/types'
import { worktreePsLastActive } from './worktree-ps-format'

/** Rows read before filtering; past it the answer says it was truncated. */
export const WORKTREE_PS_SINCE_READ_LIMIT = 2000

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

export function getOptionalDurationFlag(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = flags.get(name)
  if (value === undefined) {
    return undefined
  }
  const match = typeof value === 'string' ? /^(\d+)([mhdw])$/.exec(value.trim()) : null
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} takes an age such as 30m, 12h, 7d or 2w.`
    )
  }
  return Number(match[1]) * UNIT_MS[match[2]!]!
}

export function recentWorktreePs<T extends RuntimeWorktreePsResult>(
  result: T,
  after: number,
  limit: number | undefined
): T {
  const recent = result.worktrees
    .filter(
      (row) =>
        !row.isArchived &&
        // An agent busy or waiting right now is active, whatever the clocks say.
        (worktreePsLastActive(row) >= after || row.agents.some((agent) => agent.state !== 'done'))
    )
    .sort((a, b) => worktreePsLastActive(b) - worktreePsLastActive(a))
  const shown = limit === undefined ? recent : recent.slice(0, limit)
  return {
    ...result,
    worktrees: shown,
    totalCount: recent.length,
    truncated: result.truncated || shown.length < recent.length
  }
}
