import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import type { CodexHistoryDiskUsageBudget } from './codex-history-disk-usage-walk'

export type CodexHistoryDiskUsageWorkerRequest = {
  id: number
  roots: string[]
  budget: CodexHistoryDiskUsageBudget
}

export type CodexHistoryDiskUsageWorkerResponse =
  | { id: number; ok: true; usage: CodexHistoryDiskUsage }
  | { id: number; ok: false; error: string }
