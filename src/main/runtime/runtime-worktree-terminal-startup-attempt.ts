import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import { getSetupRunnerCommandPlatformForPath } from '../../shared/setup-runner-command'
import type {
  WorktreeProvisionTerminalOptions,
  WorktreeTerminalProvisioningArgs
} from './runtime-worktree-terminal-provisioning'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { allocateTerminalPaneIdentity } from './runtime-terminal-pane-identity'
import { trackTerminalSpawnDispatch } from '../agent-launch/agent-launch-not-started'

export class WorktreeTerminalStartupSettledError extends Error {
  constructor(
    readonly outcome:
      | 'not-attempted'
      | 'unverifiable'
      | 'recovery-primary-created'
      | 'absence-unrecovered',
    cause: unknown,
    readonly recoveryCause?: unknown,
    readonly provisioningCauses: unknown[] = []
  ) {
    super(cause instanceof Error ? cause.message : 'The agent could not start.', { cause })
    this.name = 'WorktreeTerminalStartupSettledError'
  }
}

/** The create owns the primary slot until its bounded startup and recovery have settled. */
export async function attemptWorktreeTerminalStartup(args: {
  selector: string
  options: TerminalCreateOptions
  runtimeError?: Error
  canSpawn: boolean
  owned: boolean
  recoveryOptions: TerminalCreateOptions
  create: (selector: string, options: TerminalCreateOptions) => Promise<RuntimeTerminalCreate>
}): Promise<{
  agentTerminal?: RuntimeTerminalCreate
  primaryTerminal?: RuntimeTerminalCreate
  failure?: WorktreeTerminalStartupSettledError
}> {
  if (!args.canSpawn) {
    return {
      failure: new WorktreeTerminalStartupSettledError(
        'not-attempted',
        new Error('runtime_unavailable')
      )
    }
  }
  const hinted = args.options.tabId !== undefined
  const identity = args.owned ? allocateTerminalPaneIdentity(args.options) : {}
  let cause: unknown = args.runtimeError
  let absent = args.runtimeError !== undefined && !hinted
  for (
    let attemptIndex = 0;
    !args.runtimeError && attemptIndex < (args.owned ? 2 : 1);
    attemptIndex++
  ) {
    const attempt = trackTerminalSpawnDispatch(hinted)
    try {
      const terminal = await args
        .create(args.selector, {
          ...args.options,
          ...identity,
          onPaneAcquisition: attempt.onPaneAcquisition,
          onPtySpawnDispatched: attempt.onPtySpawnDispatched
        })
        .catch(attempt.rethrow)
      return { agentTerminal: terminal, primaryTerminal: terminal }
    } catch (error) {
      cause = error
      absent = attempt.failedBeforeDispatch(error)
      if (!absent) {
        break
      }
    }
  }
  if (args.owned && absent) {
    try {
      const primaryTerminal = await args.create(args.selector, args.recoveryOptions)
      return {
        primaryTerminal,
        failure: new WorktreeTerminalStartupSettledError('recovery-primary-created', cause)
      }
    } catch (recoveryCause) {
      return {
        failure: new WorktreeTerminalStartupSettledError(
          'absence-unrecovered',
          cause,
          recoveryCause
        )
      }
    }
  }
  return { failure: new WorktreeTerminalStartupSettledError('unverifiable', cause) }
}

export type WorktreeStartupProvisioner = (options: WorktreeTerminalProvisioningArgs) => Promise<{
  setupSpawned: boolean
  setupTerminalHandle: string | null
  setupRetrySafe?: boolean
  failures?: unknown[]
}>

export async function settleWorktreeStartupProvisioning(
  provision: () => ReturnType<WorktreeStartupProvisioner>,
  owned: boolean,
  failure?: WorktreeTerminalStartupSettledError
): ReturnType<WorktreeStartupProvisioner> {
  try {
    const result = await provision()
    failure?.provisioningCauses.push(...(result.failures ?? []))
    return result
  } catch (error) {
    if (!owned || !failure) {
      throw error
    }
    failure.provisioningCauses.push(error)
    return { setupSpawned: false, setupTerminalHandle: null }
  }
}

export function setupPlatform(
  setup: CreateWorktreeResult['setup'],
  fallback: 'windows' | 'posix'
): 'windows' | 'posix' {
  return getSetupRunnerCommandPlatformForPath(setup?.runnerScriptPath ?? '', fallback)
}

export function ownerSurfacing(
  shouldSurface: boolean
): Pick<WorktreeProvisionTerminalOptions, 'surfaceOwner'> {
  return shouldSurface ? {} : { surfaceOwner: false }
}
