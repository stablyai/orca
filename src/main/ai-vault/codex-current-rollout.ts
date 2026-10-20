import { AsyncLocalStorage } from 'node:async_hooks'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  readCodexSelectedRolloutFileName,
  type CodexSelectionCache
} from '../codex/codex-current-rollout-selection'

// One read of each Codex state DB per scan.
const scanSelections = new AsyncLocalStorage<CodexSelectionCache>()

export function withCodexCurrentRolloutScan<T>(fn: () => Promise<T>): Promise<T> {
  return scanSelections.run(new Map(), fn)
}

/**
 * Whether this row's file is the segment Codex's state DB selects for its
 * thread, or null when no DB answers (Codex then falls back to the newest file).
 */
export function isCodexCurrentRollout(session: AiVaultSession): boolean | null {
  const cache = scanSelections.getStore()
  if (!cache) {
    return null
  }
  const selected = readCodexSelectedRolloutFileName(session.filePath, cache)
  return selected === null
    ? null
    : selected ===
        session.filePath
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.zst$/, '')
}
