import type {
  LocalCommandSettleParams,
  LocalCommandSettleResult
} from '../../shared/local-commands/local-command-contract'
import type { LocalCommandPrompt } from '../../shared/local-commands/local-command-desktop-types'
import type { LocalCommandAuditLog } from './local-command-audit-log'
import type { LocalCommandSubscription, LocalCommandTimer } from './local-command-attachments'
import type { LocalCommandExecutionOutcome } from './local-command-executor'
import type { LocalCommandWorkspacePolicy } from './local-command-request-checks'
import type { LocalCommandSettingsStore } from './local-command-settings-store'

export type LocalCloudWorkspaceRef = {
  sandboxId: string
  runtimeEnvironmentId: string | null
  fallbackLabel: string
}

export type LocalCommandBridgeDeps = {
  settings: LocalCommandSettingsStore
  audit: LocalCommandAuditLog
  supported: boolean
  /** Cloud workspaces this computer created (their runtime records live here). */
  listWorkspaces: () => LocalCloudWorkspaceRef[]
  /** Ownership and sharing from the Orca Cloud registry; null when it can't be read (fail closed). */
  readPolicy: (sandboxId: string) => Promise<LocalCommandWorkspacePolicy | null>
  subscribe: (
    environmentId: string,
    onEvent: (event: unknown) => void,
    onClose: () => void
  ) => Promise<LocalCommandSubscription>
  settle: (
    environmentId: string,
    params: LocalCommandSettleParams
  ) => Promise<Pick<LocalCommandSettleResult, 'accepted'>>
  resolveCwd: (requested: string | null) => Promise<string | null>
  execute: (input: {
    command: string
    cwd: string
    timeoutSec: number
  }) => Promise<LocalCommandExecutionOutcome>
  publishPrompts: (prompts: LocalCommandPrompt[]) => void
  publishState: () => void
  /** A new prompt arrived (an OS notification when Orca is in the background). */
  onPromptAdded?: (prompt: LocalCommandPrompt) => void
  now?: () => number
  setTimer?: LocalCommandTimer
  log?: (message: string) => void
}

export type PendingPrompt = {
  prompt: LocalCommandPrompt
  environmentId: string
  shownAt: number
  timer: { cancel: () => void }
}
