import type {
  CreateWorktreeResult,
  SetupDecision,
  SetupTrustMismatch
} from '../../../../shared/worktree/create-types'
import type { WorkspaceHookOwner } from '../../../../shared/workspace-hook-owner'
import { loadHooks, runHook } from '../../../workspace-hooks/hooks'
import {
  createSetupRunnerScript,
  resolveSetupRunnerShell
} from '../../../workspace-hooks/worktree-runner-script'
import {
  getDefaultTabsLaunch,
  getEffectiveHooksFromConfig,
  shouldRunSetupForCreate
} from '../../../workspace-hooks/effective-hook-config'
import {
  checkCreatedWorktreeSetupTrust,
  defaultTabsWithoutCommands,
  folderSharedSetupLacksApproval
} from '../../../workspace-hooks/created-worktree-setup-trust'
import type { HookWorkspaceIdentity } from '../../../workspace-hooks/setup-hook-env-vars'
import { scopeHooksToRepoKind } from '../../../../shared/folder-workspace-hooks'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** Share setup decision between pre-add admission and post-add execution so allowed creates cannot fail after making the worktree. */
export function resolveRuntimeSetupDecision(
  request: Pick<RuntimeManagedWorktreeCreateArgs, 'runHooks' | 'setupDecision'>
): SetupDecision {
  return request.runHooks ? 'run' : (request.setupDecision ?? 'inherit')
}

export async function prepareRuntimeLocalWorktreeSetup(args: {
  request: Pick<
    RuntimeManagedWorktreeCreateArgs,
    'runHooks' | 'setupDecision' | 'approvedSetupHash' | 'approvedSetupHashes'
  >
  repo: WorkspaceHookOwner
  worktreePath: string
  settings: ReturnType<RuntimeStore['getSettings']>
  runtimeTarget: { wslDistro?: string } | undefined
  shouldUseSetupRunner: boolean
  warning?: string
  /** Required for folder workspaces, whose shared directory can't name the workspace. */
  identity?: HookWorkspaceIdentity
}): Promise<{
  setup?: CreateWorktreeResult['setup']
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  warning?: string
  effectiveDecision: SetupDecision
  setupTrustMismatch?: SetupTrustMismatch
  hookFound: boolean
  shouldRunSetup: boolean
  didStartInProcessSetupHook: boolean
}> {
  const { request, repo, worktreePath, settings } = args
  let warning = args.warning
  let setup: CreateWorktreeResult['setup']
  const yamlHooks = scopeHooksToRepoKind(repo, loadHooks(worktreePath))
  // One parse feeds both the trust check and the runner, so approved bytes are the bytes that run.
  const hooks = getEffectiveHooksFromConfig(repo, yamlHooks)
  const effectiveDecision = resolveRuntimeSetupDecision(request)
  const setupTrustMismatch = checkCreatedWorktreeSetupTrust(
    repo,
    yamlHooks,
    effectiveDecision,
    request
  )
  const lacksFolderApproval =
    isFolderRepo(repo) &&
    folderSharedSetupLacksApproval(repo, yamlHooks, effectiveDecision, request)
  // Only the approved content may run; the client re-prompts with the branch's.
  const runDecision = setupTrustMismatch || lacksFolderApproval ? 'skip' : effectiveDecision
  if (setupTrustMismatch) {
    // Automations have no prompt to re-ask; the host log is their record of the skip.
    console.warn(`[hooks] setup skipped for ${worktreePath}: it differs from the approved content`)
  }
  if (lacksFolderApproval) {
    const skipped =
      'orca.yaml setup skipped for this folder workspace because it was not approved; pass --setup run to run it.'
    warning = warning ? `${warning} Also ${skipped}` : skipped
  }
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  try {
    const launch = getDefaultTabsLaunch(yamlHooks, repo, runDecision)
    // Approving the branch's commands opens the command tabs later.
    defaultTabs = setupTrustMismatch ? defaultTabsWithoutCommands(launch) : launch
  } catch (error) {
    console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
    defaultTabs = yamlHooks?.defaultTabs
      ? { tabs: yamlHooks.defaultTabs, runCommands: false }
      : undefined
  }
  let shouldRunSetup = false
  if (hooks?.scripts.setup) {
    try {
      shouldRunSetup = shouldRunSetupForCreate(repo, runDecision)
    } catch {
      // A new branch may introduce an unapproved hook; worktree already exists, so skip/warn below rather than fail the create.
    }
  }
  let didStartInProcessSetupHook = false
  if (shouldRunSetup && hooks?.scripts.setup) {
    if (args.shouldUseSetupRunner) {
      try {
        setup = await createSetupRunnerScript(
          repo,
          worktreePath,
          hooks.scripts.setup,
          args.runtimeTarget,
          resolveSetupRunnerShell(settings),
          yamlHooks?.setupAgentStartupPolicy,
          args.identity
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
        if (isFolderRepo(repo)) {
          const failed = `Setup did not run: Orca could not write its setup file in ${worktreePath}.`
          warning = warning ? `${warning} Also ${failed}` : failed
        }
      }
    } else {
      didStartInProcessSetupHook = true
      void runHook('setup', worktreePath, repo, worktreePath, args.runtimeTarget, {
        identity: args.identity
      }).then((result) => {
        if (!result.success) {
          console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
        }
      })
    }
  } else if (hooks?.scripts.setup && runDecision !== 'skip') {
    const skipped = `orca.yaml setup hook skipped for ${worktreePath}; pass --setup run to run it.`
    warning = warning ? `${warning} Also ${skipped}` : skipped
    console.warn(`[hooks] ${skipped}`)
  }
  return {
    ...(setup ? { setup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(warning ? { warning } : {}),
    effectiveDecision,
    ...(setupTrustMismatch ? { setupTrustMismatch } : {}),
    hookFound: Boolean(hooks?.scripts.setup),
    shouldRunSetup,
    didStartInProcessSetupHook
  }
}

export function buildRuntimeSetupReceipt(
  prepared: Awaited<ReturnType<typeof prepareRuntimeLocalWorktreeSetup>>,
  didSpawnSetup: boolean,
  terminalHandle: string | null | undefined
): NonNullable<CreateWorktreeResult['setupReceipt']> {
  const { effectiveDecision, hookFound, shouldRunSetup, setup } = prepared
  return {
    requested: effectiveDecision,
    hookFound,
    startupPolicy: setup?.waitForAgentStartup ? 'wait-for-setup' : 'start-immediately',
    state: !hookFound
      ? 'not_configured'
      : effectiveDecision === 'skip' || !shouldRunSetup
        ? 'skipped'
        : // The in-process setup hook already started; spawn_failed would strand retrying callers.
          didSpawnSetup || prepared.didStartInProcessSetupHook
          ? 'running'
          : 'spawn_failed',
    ...(terminalHandle ? { terminalHandle } : {})
  }
}
