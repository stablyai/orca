import type { CodexHistoryDiskUsage } from '../../../../shared/workspace-cleanup/codex-history-disk-usage'
import type { CodexAccountHomeCandidate } from '../../../codex-accounts/managed-homes/host-codex-managed-home-ownership'

/** `timeMs` starts when the worker picks the request up, not while it waits behind another walk. */
export type CodexHistoryDiskUsageBudget = { maxEntries: number; timeMs: number }

export type CodexHistoryDiskUsageWorkerRequest = {
  id: number
  homes: string[]
  /** Account folders whose ownership the worker checks, since those reads block. */
  accounts: CodexAccountHomeCandidate[]
  systemCodexHomePath: string
  budget: CodexHistoryDiskUsageBudget
}

export type CodexHistoryDiskUsageWorkerResponse =
  | { id: number; ok: true; usage: CodexHistoryDiskUsage }
  | { id: number; ok: false; error: string }
