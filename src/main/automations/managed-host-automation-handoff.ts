import type { Automation } from '../../shared/automations-types'
import { automationCanonicalLaunchSetup } from '../../shared/automation-launch-setup'
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import {
  getManagedOrcadSshTargetId,
  type ManagedOrcadEnvironmentSummary
} from '../../shared/managed-orcad-execution-host'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { Store } from '../persistence/loading-store/store'
import { managedOrcadHostOf } from './orcad-fenced-automation'

export type ManagedHostHandoffDeps = {
  store: Pick<Store, 'getSshTarget' | 'automationOwnerPrecondition' | 'deleteAutomation'>
  environments: () => readonly ManagedOrcadEnvironmentSummary[]
  callServer: (
    environmentId: string,
    method: string,
    params: unknown
  ) => Promise<RuntimeRpcResponse<unknown>>
}

/** The same definition, keyed by the desktop row's id so a repeat after a crash finds the first copy. */
function serverCreateParams(automation: Automation): Record<string, unknown> {
  return {
    creationKey: automation.id,
    name: automation.name,
    prompt: automation.prompt,
    precheck: automation.precheck,
    agentId: automation.agentId,
    launchSetupPatch: { copy: automationCanonicalLaunchSetup(automation) },
    sourceContext: automation.sourceContext ?? undefined,
    repo: `id:${getAutomationRunRepoId(automation)}`,
    ...(automation.workspaceMode === 'existing' && automation.workspaceId
      ? { workspace: `id:${automation.workspaceId}` }
      : {}),
    workspaceMode: automation.workspaceMode,
    baseBranch: automation.baseBranch,
    setupDecision: automation.setupDecision,
    reuseSession: automation.reuseSession,
    timezone: automation.timezone,
    rrule: automation.rrule,
    dtstart: automation.dtstart,
    enabled: automation.enabled,
    missedRunGraceMinutes: automation.missedRunGraceMinutes
  }
}

/**
 * Moves a desktop row on a managed SSH host to that host's Orca server (#24863): create there, then
 * drop the desktop copy. False leaves it skipped here; the next trigger is the retry.
 */
export async function handOffManagedHostAutomation(
  deps: ManagedHostHandoffDeps,
  automation: Automation
): Promise<boolean> {
  const host = managedOrcadHostOf(deps.store, automation)
  const server = host
    ? deps.environments().find((environment) => getManagedOrcadSshTargetId(environment) === host.id)
    : undefined
  if (!server) {
    return false
  }
  let created: RuntimeRpcResponse<unknown>
  try {
    created = await deps.callServer(server.id, 'automation.create', serverCreateParams(automation))
  } catch (error) {
    console.warn('[automations] server unreachable for', automation.id, error)
    return false
  }
  // A server without the project refuses; the row keeps its skip reason and Move button.
  if (!created.ok) {
    console.warn('[automations] left on the desktop:', automation.id, created.error.message)
    return false
  }
  // SSH-owned rows only delete under the owner they were listed with.
  const expectedOwner = deps.store.automationOwnerPrecondition(automation.id) ?? undefined
  deps.store.deleteAutomation(automation.id, expectedOwner ? { expectedOwner } : undefined)
  return true
}
