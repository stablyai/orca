import type { AgentTokenUsageDaily } from '../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import type { UsageWorktreeRef } from './worktree-attribution/usage-worktree-metadata'

export type UsageWorktreeCatalog = {
  repoIds: string[]
  worktreesByRepo: [string, UsageWorktreeRef[]][]
}

export type UsageTelemetryHost = {
  isEnabled(): Promise<boolean>
  capture(totals: AgentTokenUsageDaily): Promise<boolean>
}

export type UsageStoreHost = {
  signal: AbortSignal
  userDataPath: string
  readCatalog(): Promise<UsageWorktreeCatalog>
  claudeProfileDirs(): Promise<string[]>
  telemetry: UsageTelemetryHost
}
