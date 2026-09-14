import type { CodexThreadItem } from './codex-structured-item-translation'

/** Persistent exec has its own process-exit notification, independent of a turn. */
export function codexCommandOutlivesTurn(item: CodexThreadItem): boolean {
  return item.type === 'commandExecution' && item.source === 'unifiedExecStartup'
}
