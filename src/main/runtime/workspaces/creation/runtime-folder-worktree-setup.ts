import { isRepoOnCatalogHost } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type { CreateWorktreeResult } from '../../../../shared/worktree/create-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeStartupLaunch } from '../../../../shared/worktree/creation/launch-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  startRuntimeLocalWorktreeTerminals,
  type RuntimeLocalWorktreeTerminalPorts
} from '../startup/runtime-local-worktree-terminal-startup'
import type {
  WorktreeStartupDraftPaste,
  WorktreeStartupFollowup
} from '../startup/runtime-worktree-agent-startup'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import {
  buildRuntimeSetupReceipt,
  prepareRuntimeLocalWorktreeSetup,
  resolveRuntimeSetupDecision
} from './runtime-local-worktree-setup'
import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'

export type RuntimeFolderWorktreeSetupDeps = {
  runtimeTarget: () => { wslDistro?: string } | undefined
  shouldUseSetupRunner: boolean
}

type PreparedFolderSetup = Awaited<ReturnType<typeof prepareRuntimeLocalWorktreeSetup>>

/**
 * Only the host whose catalog holds the folder may read its orca.yaml or write runners there.
 * The workspace already exists, so a setup problem becomes a warning, never a failed create.
 */
export async function prepareFolderWorktreeSetup(args: {
  request: Parameters<typeof prepareRuntimeLocalWorktreeSetup>[0]['request'] & {
    wslUserAct?: true
  }
  repo: Repo
  worktree: Pick<Worktree, 'id' | 'path' | 'displayName'>
  settings: ReturnType<RuntimeStore['getSettings']>
  runtimeTarget: () => { wslDistro?: string } | undefined
  shouldUseSetupRunner: boolean
}): Promise<PreparedFolderSetup | { warning: string } | undefined> {
  const { repo, worktree, request } = args
  // A skipped setup needs no file access, so metadata-only creates stay metadata-only.
  if (!isRepoOnCatalogHost(repo) || resolveRuntimeSetupDecision(request) === 'skip') {
    return undefined
  }
  // Only a create someone started may start the folder's stopped WSL distro.
  if (!request.wslUserAct && (await blockedWslDistroForPath(repo.path))) {
    return { warning: "Setup did not run because the folder's WSL distro isn't running." }
  }
  try {
    return await prepareRuntimeLocalWorktreeSetup({
      request: args.request,
      repo,
      worktreePath: worktree.path,
      settings: args.settings,
      runtimeTarget: args.runtimeTarget(),
      shouldUseSetupRunner: args.shouldUseSetupRunner,
      identity: { worktreeId: worktree.id, displayName: worktree.displayName }
    })
  } catch (error) {
    console.error(`[hooks] setup preparation failed for ${worktree.path}:`, error)
    const message = error instanceof Error ? error.message : String(error)
    return { warning: `Setup did not run for this folder workspace: ${message}` }
  }
}

export function isPreparedFolderSetup(
  value: PreparedFolderSetup | { warning: string } | undefined
): value is PreparedFolderSetup {
  return value !== undefined && 'effectiveDecision' in value
}

/** Folder workspaces start setup and agents exactly as worktrees do, Setup-before-agent order included. */
export async function startRuntimeFolderWorktreeSetupTerminals(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  worktree: Worktree
  prepared: PreparedFolderSetup
  startup?: WorktreeStartupLaunch
  startupFollowup?: WorktreeStartupFollowup
  startupLaunchRuntime?: AgentLaunchRuntime | Error
  createdWithAgent?: TuiAgent
  promisedAgentChat?: boolean
  draftPaste?: WorktreeStartupDraftPaste
  terminals: RuntimeLocalWorktreeTerminalPorts
}): Promise<Pick<CreateWorktreeResult, 'setup' | 'setupReceipt' | 'startupTerminal' | 'warning'>> {
  const { request, prepared } = args
  const started = await startRuntimeLocalWorktreeTerminals({
    request,
    repo: args.repo,
    worktree: args.worktree,
    setup: prepared.setup,
    startup: args.startup,
    startupFollowup: args.startupFollowup,
    startupLaunchRuntime: args.startupLaunchRuntime,
    createdWithAgent: args.createdWithAgent,
    promisedAgentChat: args.promisedAgentChat,
    draftPaste: args.draftPaste,
    warning: prepared.warning,
    ports: args.terminals
  })
  return {
    ...(started.returnedSetup ? { setup: started.returnedSetup } : {}),
    ...(request.awaitTerminalProvisioning
      ? {
          setupReceipt: buildRuntimeSetupReceipt(
            prepared,
            started.didSpawnSetup,
            started.setupTerminalHandle
          )
        }
      : {}),
    ...(started.didSpawnStartup && started.startupTerminalHandle
      ? {
          startupTerminal: {
            spawned: true,
            handle: started.startupTerminalHandle,
            ...(started.startupTerminalTabId ? { tabId: started.startupTerminalTabId } : {}),
            ...(started.startupTerminalPaneKey ? { paneKey: started.startupTerminalPaneKey } : {}),
            ...(started.startupTerminalPtyId ? { ptyId: started.startupTerminalPtyId } : {}),
            surface: 'background' as const
          }
        }
      : {}),
    ...(started.warning ? { warning: started.warning } : {})
  }
}
