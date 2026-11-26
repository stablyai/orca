import { join } from 'node:path'
import { codexDatedRolloutRelativePath } from '../resume/codex-session-resume-home'

export type RolloutName = { path: string; root: string }

/** The `YYYY/MM/DD/rollout-*.jsonl` stem in one of these homes; archived `.zst` maps to its `.jsonl`. */
export function rolloutStem(homes: readonly string[], filePath: string): string | null {
  for (const home of homes) {
    const relativePath = codexDatedRolloutRelativePath(join(home, 'sessions'), filePath)
    if (relativePath) {
      return relativePath.replace(/\.zst$/, '')
    }
  }
  return null
}

/** Codex compresses idle rollouts and history passes link them across homes, so match by name. */
export function rolloutNames(homes: readonly string[], stem: string): RolloutName[] {
  const parts = stem.split('/')
  const fileName = parts.at(-1) ?? stem
  return homes.flatMap((home) => {
    const sessions = join(home, 'sessions')
    const archived = join(home, 'archived_sessions')
    return [
      { path: join(sessions, ...parts), root: sessions },
      { path: `${join(sessions, ...parts)}.zst`, root: sessions },
      { path: join(archived, fileName), root: archived },
      { path: `${join(archived, fileName)}.zst`, root: archived }
    ]
  })
}
