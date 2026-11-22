import type { CodexThreadItem } from './codex-thread-item-identity'

/** Persistent exec has its own process-exit notification, independent of a turn. */
export function codexCommandOutlivesTurn(item: CodexThreadItem): boolean {
  return item.type === 'commandExecution' && item.source === 'unifiedExecStartup'
}
