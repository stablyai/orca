import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { WorktreeStartupLaunch } from '../../shared/worktree/launch-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from './runtime-worktree-agent-startup'
import type { WorktreeTerminalProvisioningArgs } from './runtime-worktree-terminal-provisioning'

export type RuntimeLocalWorktreeTerminalStartupPorts = {
  canSpawn: boolean
  provisionInBackground?: () => boolean
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  pasteDraft: (handle: string, draft: WorktreeStartupDraftPaste) => void
  sendFollowup: (
    handle: string,
    followup: WorktreeStartupFollowup,
    terminal: RuntimeTerminalCreate
  ) => void
  provision: (
    options: WorktreeTerminalProvisioningArgs
  ) => Promise<{ setupSpawned: boolean; setupTerminalHandle: string | null }>
  activate: (
    repoId: string,
    worktreeId: string,
    startup?: WorktreeStartupLaunch,
    // Only work main tried to start and failed; the host window retries it where the user sees it.
    failedSetup?: CreateWorktreeResult['setup'],
    failedDefaultTabs?: CreateWorktreeResult['defaultTabs'],
    providesInitialSurface?: boolean
  ) => void
}

export type RuntimeLocalWorktreeTerminalStartupResult = {
  warning?: string
  returnedSetup?: CreateWorktreeResult['setup']
  didSpawnSetup: boolean
  didSpawnStartup: boolean
  setupTerminalHandle: string | null
  startupTerminalHandle: string | null
  startupTerminalTabId: string | null
  startupTerminalPaneKey: string | null
  startupTerminalPtyId: string | null
}
