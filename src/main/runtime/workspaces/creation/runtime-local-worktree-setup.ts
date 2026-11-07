import type {
  CreateWorktreeResult,
  SetupDecision,
  SetupTrustMismatch
} from '../../../../shared/worktree/create-types'
import type { Repo } from '../../../../shared/repo-types'
import { getEffectiveHooks, loadHooks, runHook } from '../../../workspace-hooks/hooks'
import {
  createSetupRunnerScript,
  resolveSetupRunnerShell
} from '../../../workspace-hooks/worktree-runner-script'
import {
  getDefaultTabsLaunch,
  shouldRunSetupForCreate
} from '../../../workspace-hooks/effective-hook-config'
import {
  checkCreatedWorktreeSetupTrust,
  defaultTabsWithoutCommands
} from '../../../workspace-hooks/created-worktree-setup-trust'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from '../../runtime-store-contract'

/** Share setup decision between pre-add admission and post-add execution so allowed creates cannot fail after making the worktree. */
export function resolveRuntimeSetupDecision(
  request: Pick<RuntimeManagedWorktreeCreateArgs, 'runHooks' | 'setupDecision'>
): SetupDecision {
  return request.runHooks ? 'run' : (request.setupDecision ?? 'inherit')
}

export async function prepareRuntimeLocalWorktreeSetup(args: {
  request: RuntimeManagedWorktreeCreateArgs
  repo: Repo
  worktreePath: string
  settings: ReturnType<RuntimeStore['getSettings']>
  runtimeTarget: { wslDistro?: string } | undefined
  shouldUseSetupRunner: boolean
  warning?: string
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
  const yamlHooks = loadHooks(worktreePath)
  const hooks = getEffectiveHooks(repo, worktreePath)
  const effectiveDecision = resolveRuntimeSetupDecision(request)
  const setupTrustMismatch = checkCreatedWorktreeSetupTrust(
    repo,
    yamlHooks,
    effectiveDecision,
    request
  )
  // Only the approved content may run; the client re-prompts with the branch's.
  const runDecision = setupTrustMismatch ? 'skip' : effectiveDecision
  if (setupTrustMismatch) {
    // Automations have no prompt to re-ask; the host log is their record of the skip.
    console.warn(`[hooks] setup skipped for ${worktreePath}: it differs from the approved content`)
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
          yamlHooks?.setupAgentStartupPolicy
        )
      } catch (error) {
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    } else {
      didStartInProcessSetupHook = true
      void runHook('setup', worktreePath, repo, worktreePath, args.runtimeTarget).then((result) => {
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
