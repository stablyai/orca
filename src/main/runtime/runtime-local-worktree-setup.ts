import type { CreateWorktreeResult, SetupDecision } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { getEffectiveHooks, loadHooks, runHook } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { shouldWaitForSetupBeforeAgentStartup } from '../../shared/setup-agent-startup-policy'
import { createSetupRun, type SetupRun } from './setup/setup-run'
import type { RuntimeStore } from './runtime-store-contract'

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
  setupRun?: SetupRun
  defaultTabs?: CreateWorktreeResult['defaultTabs']
  warning?: string
  effectiveDecision: SetupDecision
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
  let defaultTabs: CreateWorktreeResult['defaultTabs']
  try {
    defaultTabs = getDefaultTabsLaunch(yamlHooks, repo, effectiveDecision)
  } catch (error) {
    console.warn(`[hooks] default tab commands skipped for ${worktreePath}:`, error)
    defaultTabs = yamlHooks?.defaultTabs
      ? { tabs: yamlHooks.defaultTabs, runCommands: false }
      : undefined
  }
  let shouldRunSetup = false
  if (hooks?.scripts.setup) {
    try {
      shouldRunSetup = shouldRunSetupForCreate(repo, effectiveDecision)
    } catch {
      // A new branch may introduce an unapproved hook; worktree already exists, so skip/warn below rather than fail the create.
    }
  }
  const setupRun =
    shouldRunSetup &&
    (request.observeSetupCompletion || request.promisedAgentChat || args.shouldUseSetupRunner)
      ? createSetupRun(
          shouldWaitForSetupBeforeAgentStartup(
            repo.hookSettings?.setupAgentStartupPolicy,
            yamlHooks?.setupAgentStartupPolicy
          )
        )
      : undefined
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
        setupRun?.settle({ kind: 'ended', reason: 'preparation_failed' })
        console.error(`[hooks] Failed to prepare setup runner for ${worktreePath}:`, error)
      }
    } else {
      didStartInProcessSetupHook = true
      void runHook('setup', worktreePath, repo, worktreePath, args.runtimeTarget)
        .then((result) => {
          setupRun?.settle(
            result.success
              ? { kind: 'succeeded' }
              : { kind: 'failed', exitCode: result.exitCode ?? 1 }
          )
          if (!result.success) {
            console.error(`[hooks] setup hook failed for ${worktreePath}:`, result.output)
          }
        })
        .catch(() => setupRun?.settle({ kind: 'ended', reason: 'observation_lost' }))
    }
  } else if (hooks?.scripts.setup && effectiveDecision !== 'skip') {
    const skipped = `orca.yaml setup hook skipped for ${worktreePath}; pass --setup run to run it.`
    warning = warning ? `${warning} Also ${skipped}` : skipped
    console.warn(`[hooks] ${skipped}`)
  }
  return {
    ...(setupRun ? { setupRun } : {}),
    ...(setup ? { setup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(warning ? { warning } : {}),
    effectiveDecision,
    hookFound: Boolean(hooks?.scripts.setup),
    shouldRunSetup,
    didStartInProcessSetupHook
  }
}

export function runtimeWorktreeSetupReceipt(
  preparation: Awaited<ReturnType<typeof prepareRuntimeLocalWorktreeSetup>>,
  didSpawnSetup: boolean,
  setupTerminalHandle: string | null
): NonNullable<CreateWorktreeResult['setupReceipt']> {
  const { effectiveDecision, hookFound, setupRun, shouldRunSetup, didStartInProcessSetupHook } =
    preparation
  return {
    requested: effectiveDecision,
    hookFound,
    startupPolicy: setupRun?.waitsForAgent ? 'wait-for-setup' : 'start-immediately',
    state: !hookFound
      ? 'not_configured'
      : effectiveDecision === 'skip' || !shouldRunSetup
        ? 'skipped'
        : didSpawnSetup || didStartInProcessSetupHook
          ? 'running'
          : 'spawn_failed',
    ...(setupTerminalHandle ? { terminalHandle: setupTerminalHandle } : {})
  }
}
