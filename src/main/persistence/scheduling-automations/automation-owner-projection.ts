import type { Automation, AutomationRun } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  automationCapturedHostIssue as resolveAutomationCapturedHostIssue,
  automationSelectorMatchesScope,
  projectAutomationList,
  projectAutomationSelector,
  toAutomationChangeSelector,
  type AutomationCapturedHostIssue,
  type AutomationChangeSelector,
  type AutomationListParams,
  type AutomationListResult,
  type AutomationProjectionContext
} from '../../../shared/automation-list-scope'
import {
  assertAutomationOwnerFence as enforceAutomationOwnerFence,
  toAutomationOwnerPrecondition,
  type AutomationOwnerFenceOperation,
  type AutomationOwnerPrecondition
} from '../../../shared/automation-owner-precondition'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../../shared/automation-owner-conflict'
import {
  nextSshTargetGeneration,
  resolveSshTargetGenerationHighWaterMark,
  sanitizeSshTargetGeneration
} from '../../../shared/ssh-target-generation'
import {
  resolveAutomationWorkspaceHost,
  resolveAutomationWorkspaceSshTargetId,
  type AutomationWorkspaceSshPin
} from '../../../shared/automation-workspace-pin'
import { summarizeAutomationRunUsage } from '../../../shared/automation-usage-summary'
import type { FolderWorkspaceHostState } from '../../../shared/folder-workspace-execution-host'

export type AutomationStorageAuthority = 'desktop' | 'runtime'

export type AutomationListProjectionCache = {
  inputs: readonly unknown[]
  result: AutomationListResult
}

export function sshTargetGenerationForConnection(
  state: PersistedState,
  connectionId: string | null | undefined
): number | undefined {
  const targetId = connectionId?.trim()
  const target = targetId ? state.sshTargets?.find((entry) => entry.id === targetId) : undefined
  return sanitizeSshTargetGeneration(target?.generation)
}

function automationUsageSummaries(state: PersistedState) {
  const runsByAutomation = new Map<string, AutomationRun[]>()
  for (const run of state.automationRuns ?? []) {
    const runs = runsByAutomation.get(run.automationId)
    if (runs) {
      runs.push(run)
    } else {
      runsByAutomation.set(run.automationId, [run])
    }
  }
  return new Map([...runsByAutomation].map(([id, runs]) => [id, summarizeAutomationRunUsage(runs)]))
}

function folderWorkspaceHostState(state: PersistedState): FolderWorkspaceHostState {
  return {
    folderWorkspaces: state.folderWorkspaces ?? [],
    projectGroups: state.projectGroups ?? [],
    repos: state.repos ?? []
  }
}

export function automationIdsPinnedToSshTarget(
  state: PersistedState,
  targetId: string
): Set<string> {
  const hostState = folderWorkspaceHostState(state)
  return new Set(
    (state.automations ?? [])
      .filter(
        (automation) =>
          resolveAutomationWorkspaceSshTargetId(hostState, automation.workspaceId) === targetId
      )
      .map((automation) => automation.id)
  )
}

export function automationWorkspaceSshPin(
  state: PersistedState,
  workspaceId: Automation['workspaceId']
): AutomationWorkspaceSshPin | undefined {
  const targetId = resolveAutomationWorkspaceSshTargetId(
    folderWorkspaceHostState(state),
    workspaceId
  )
  return targetId === undefined
    ? undefined
    : { targetId, generation: sshTargetGenerationForConnection(state, targetId) }
}

export function automationProjectionContext(
  state: PersistedState,
  storageAuthority: AutomationStorageAuthority,
  withUsage: boolean
): AutomationProjectionContext {
  const usage = withUsage ? automationUsageSummaries(state) : null
  const reposById = new Map(state.repos.map((repo) => [repo.id, repo]))
  const targetIdByGeneration = new Map(
    (state.sshTargets ?? []).flatMap((target) =>
      target.generation === undefined ? [] : [[target.generation, target.id] as const]
    )
  )
  return {
    storageAuthority,
    sshTargetGeneration: (targetId) => sshTargetGenerationForConnection(state, targetId),
    sshTargetIdForGeneration: (generation) => targetIdByGeneration.get(generation),
    repoConnectionId: (repoId) => {
      const repo = reposById.get(repoId)
      return repo ? repo.connectionId?.trim() || null : undefined
    },
    workspaceHost: (automation) =>
      resolveAutomationWorkspaceHost(folderWorkspaceHostState(state), automation.workspaceId),
    ...(usage ? { usageSummary: (id: string) => usage.get(id) ?? null } : {})
  }
}

function projectionInputs(state: PersistedState): readonly unknown[] {
  return [
    state.automations,
    state.automationRuns,
    state.repos,
    state.sshTargets,
    state.folderWorkspaces,
    state.projectGroups
  ]
}

export function listAutomationsForScope(input: {
  state: PersistedState
  storageAuthority: AutomationStorageAuthority
  automations: readonly Automation[]
  params?: AutomationListParams | null
  cache: AutomationListProjectionCache | null
}): { result: AutomationListResult; cache: AutomationListProjectionCache } {
  const scope = input.params?.selector
  if (scope?.kind === 'ssh') {
    const current = sshTargetGenerationForConnection(input.state, scope.targetId)
    if (current === undefined) {
      throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved)
    }
    if (current !== scope.expectedTargetGeneration) {
      throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
    }
  }
  const inputs = projectionInputs(input.state)
  const complete =
    input.cache && inputs.every((entry, index) => entry === input.cache?.inputs[index])
      ? input.cache
      : {
          inputs,
          result: projectAutomationList(
            input.automations,
            automationProjectionContext(input.state, input.storageAuthority, true)
          )
        }
  if (!scope) {
    return { result: complete.result, cache: complete }
  }
  const items = complete.result.items.filter((item) =>
    automationSelectorMatchesScope(item.selector, scope)
  )
  const ids = new Set(items.map((item) => item.automationId))
  return {
    result: {
      automations: complete.result.automations.filter((automation) => ids.has(automation.id)),
      items,
      orphanCount: complete.result.orphanCount
    },
    cache: complete
  }
}

export function automationOwnerPrecondition(
  state: PersistedState,
  storageAuthority: AutomationStorageAuthority,
  id: string
): AutomationOwnerPrecondition | null {
  const automation = (state.automations ?? []).find((entry) => entry.id === id)
  return automation
    ? toAutomationOwnerPrecondition(
        projectAutomationSelector(
          automation,
          automationProjectionContext(state, storageAuthority, false)
        )
      )
    : null
}

export function automationChangeSelector(
  state: PersistedState,
  storageAuthority: AutomationStorageAuthority,
  id: string
): AutomationChangeSelector | null {
  const automation = (state.automations ?? []).find((entry) => entry.id === id)
  return automation
    ? toAutomationChangeSelector(
        projectAutomationSelector(
          automation,
          automationProjectionContext(state, storageAuthority, false)
        )
      )
    : null
}

export function automationCapturedHostIssue(
  state: PersistedState,
  storageAuthority: AutomationStorageAuthority,
  automation: Automation
): AutomationCapturedHostIssue | null {
  return resolveAutomationCapturedHostIssue(
    automation,
    automationProjectionContext(state, storageAuthority, false)
  )
}

export function assertAutomationOwnerFence(input: {
  state: PersistedState
  storageAuthority: AutomationStorageAuthority
  id: string
  expectedOwner?: AutomationOwnerPrecondition
  operation: AutomationOwnerFenceOperation
}): Automation {
  const automation = (input.state.automations ?? []).find((entry) => entry.id === input.id)
  if (!automation) {
    throw new Error('Automation not found.')
  }
  enforceAutomationOwnerFence({
    automation,
    expectedOwner: input.expectedOwner,
    operation: input.operation,
    context: automationProjectionContext(input.state, input.storageAuthority, false)
  })
  return automation
}

export function allocateSshTargetGeneration(
  state: PersistedState,
  scheduleSave: () => void
): number {
  const next = nextSshTargetGeneration(
    resolveSshTargetGenerationHighWaterMark({
      persistedCounter: state.sshTargetGenerationCounter,
      targetGenerations: (state.sshTargets ?? []).map((target) => target.generation),
      capturedGenerations: (state.automations ?? []).map(
        (automation) => automation.executionTargetGeneration
      )
    })
  )
  state.sshTargetGenerationCounter = next
  scheduleSave()
  return next
}
