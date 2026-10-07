import type { CreateWorktreeResult, SetupDecision } from '../../shared/worktree/create-types'
import type { Repo } from '../../shared/repo-types'
import { getEffectiveHooks, loadHooks, runHook } from '../hooks'
import { createSetupRunnerScript, resolveSetupRunnerShell } from '../worktree-runner-script'
import { getDefaultTabsLaunch, shouldRunSetupForCreate } from '../effective-hook-config'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import type { RuntimeStore } from './runtime-store-contract'

/** Why one place: the pre-add refusal and the post-add setup must read the same decision, or a
 *  create the first allowed could fail the second with the worktree already on disk. */
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
      // Why: the new branch may add a setup hook the caller never decided on; the worktree exists,
      // so skip setup rather than fail the create, as the desktop create does. The skipped-hook
      // branch below logs and returns the warning.
    }
  }
  let didStartInProcessSetupHook = false
  if (shouldRunSetup && hooks?.scripts.setup) {
    if (args.shouldUseSetupRunner) {
      try {
        setup = createSetupRunnerScript(
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
  } else if (hooks?.scripts.setup && effectiveDecision !== 'skip') {
    const skipped = `orca.yaml setup hook skipped for ${worktreePath}; pass --setup run to run it.`
    warning = warning ? `${warning} Also ${skipped}` : skipped
    console.warn(`[hooks] ${skipped}`)
  }
  return {
    ...(setup ? { setup } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    ...(warning ? { warning } : {}),
    effectiveDecision,
    hookFound: Boolean(hooks?.scripts.setup),
    shouldRunSetup,
    didStartInProcessSetupHook
  }
}
