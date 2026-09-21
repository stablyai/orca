import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunTrigger,
  AutomationUpdateInput
} from '../../../shared/automations-types'
import type {
  AutomationCapturedHostIssue,
  AutomationChangeSelector,
  AutomationListParams,
  AutomationListResult
} from '../../../shared/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerFenceOperation,
  AutomationOwnerPrecondition
} from '../../../shared/automation-owner-precondition'
import { getWorktreePathBasenameFromId } from '../../../shared/worktree/id'
import { normalizeAutomationRunWorkspaceDisplayName } from '../scheduling-automations/automation-context-migration'
import {
  createAutomation as createAutomationOperation,
  deleteAutomation as deleteAutomationOperation,
  listAutomations as listAutomationsOperation,
  updateAutomation as updateAutomationOperation,
  type AutomationDefinitionOperations
} from '../scheduling-automations/automation-definition-operations'
import {
  createAutomationRun as createAutomationRunOperation,
  listAutomationRuns as listAutomationRunsOperation,
  listAutomationRunsPage as listAutomationRunsOperationPage,
  recordRepeatedAutomationSkip as recordRepeatedAutomationSkipOperation,
  snapshotAutomationRunWorkspaceDisplayName as snapshotAutomationRunWorkspaceDisplayNameOperation,
  updateAutomationRun as updateAutomationRunOperation,
  type AutomationRunOperations
} from '../scheduling-automations/automation-run-operations'
import {
  advanceAutomationNextRun as advanceAutomationNextRunOperation,
  getLatestAutomationOccurrence as getLatestAutomationOccurrenceOperation
} from '../scheduling-automations/automation-schedule-operations'
import {
  assertAutomationOwnerFence as assertAutomationOwnerFenceOperation,
  automationCapturedHostIssue as automationCapturedHostIssueOperation,
  automationChangeSelector as automationChangeSelectorOperation,
  automationOwnerPrecondition as automationOwnerPreconditionOperation,
  listAutomationsForScope as listAutomationsForScopeOperation
} from '../scheduling-automations/automation-owner-projection'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { ProfilePreferences } from './profile-preferences'

type AutomationPersistenceRuntime = Pick<
  StoreRuntimeState,
  'automationListProjectionCache' | 'state' | 'storageAuthority'
>

const automationPersistenceContext = Symbol('AutomationPersistence')
type AutomationPersistenceContext = {
  runtime: AutomationPersistenceRuntime
  flushBarriers: WriteFlushBarrierOperations
  preferences: ProfilePreferences
}

export class AutomationPersistence {
  readonly [automationPersistenceContext]: AutomationPersistenceContext

  constructor(
    runtime: AutomationPersistenceRuntime,
    flushBarriers: WriteFlushBarrierOperations,
    preferences: ProfilePreferences
  ) {
    this[automationPersistenceContext] = { runtime, flushBarriers, preferences }
  }

  listAutomations(): Automation[] {
    return listAutomationsOperation(this[automationPersistenceContext].runtime.state)
  }

  listAutomationsForScope(params?: AutomationListParams | null): AutomationListResult {
    const runtime = this[automationPersistenceContext].runtime
    const projection = listAutomationsForScopeOperation({
      state: runtime.state,
      storageAuthority: runtime.storageAuthority,
      automations: this.listAutomations(),
      params,
      cache: runtime.automationListProjectionCache
    })
    runtime.automationListProjectionCache = projection.cache
    return projection.result
  }

  automationOwnerPrecondition(id: string): AutomationOwnerPrecondition | null {
    const runtime = this[automationPersistenceContext].runtime
    return automationOwnerPreconditionOperation(runtime.state, runtime.storageAuthority, id)
  }

  automationChangeSelector(id: string): AutomationChangeSelector | null {
    const runtime = this[automationPersistenceContext].runtime
    return automationChangeSelectorOperation(runtime.state, runtime.storageAuthority, id)
  }

  automationCapturedHostIssue(automation: Automation): AutomationCapturedHostIssue | null {
    const runtime = this[automationPersistenceContext].runtime
    return automationCapturedHostIssueOperation(runtime.state, runtime.storageAuthority, automation)
  }

  assertAutomationOwnerFence(input: {
    id: string
    expectedOwner?: AutomationOwnerPrecondition
    operation: AutomationOwnerFenceOperation
  }): Automation {
    const runtime = this[automationPersistenceContext].runtime
    return assertAutomationOwnerFenceOperation({
      state: runtime.state,
      storageAuthority: runtime.storageAuthority,
      ...input
    })
  }

  listAutomationRuns(automationId?: string): AutomationRun[] {
    return listAutomationRunsOperation(
      this[automationPersistenceContext].runtime.state,
      automationId
    )
  }

  listAutomationRunsPage(automationId?: string, limit?: number, cursor?: string) {
    return listAutomationRunsOperationPage(
      this[automationPersistenceContext].runtime.state,
      automationId,
      limit,
      cursor
    )
  }

  createAutomation(
    input: AutomationCreateInput,
    options?: { destination?: AutomationDestination }
  ): Automation {
    return createAutomationOperation(getAutomationDefinitionOperations(this), input, options)
  }

  updateAutomation(
    id: string,
    updates: AutomationUpdateInput,
    options?: { expectedOwner?: AutomationOwnerPrecondition; destination?: AutomationDestination }
  ): Automation {
    return updateAutomationOperation(getAutomationDefinitionOperations(this), id, updates, options)
  }

  deleteAutomation(id: string, options?: { expectedOwner?: AutomationOwnerPrecondition }): void {
    deleteAutomationOperation(getAutomationDefinitionOperations(this), id, options)
  }

  createAutomationRun(
    automation: Automation,
    scheduledFor: number,
    trigger: AutomationRunTrigger = 'scheduled'
  ): AutomationRun {
    return createAutomationRunOperation(
      getAutomationRunOperations(this),
      automation,
      scheduledFor,
      trigger
    )
  }

  recordRepeatedAutomationSkip(
    automationId: string,
    error: string,
    scheduledFor: number
  ): AutomationRun | null {
    return recordRepeatedAutomationSkipOperation(
      getAutomationRunOperations(this),
      automationId,
      error,
      scheduledFor
    )
  }

  updateAutomationRun(result: AutomationDispatchResult): AutomationRun {
    return updateAutomationRunOperation(getAutomationRunOperations(this), result)
  }

  snapshotAutomationRunWorkspaceDisplayName(workspaceId: string, displayName: string): number {
    return snapshotAutomationRunWorkspaceDisplayNameOperation(
      getAutomationRunOperations(this),
      workspaceId,
      displayName
    )
  }

  advanceAutomationNextRun(id: string, now = Date.now()): Automation {
    return advanceAutomationNextRunOperation(
      this[automationPersistenceContext].runtime.state,
      () => this[automationPersistenceContext].flushBarriers.flush(),
      id,
      now
    )
  }

  getLatestAutomationOccurrence(automation: Automation, now = Date.now()): number | null {
    return getLatestAutomationOccurrenceOperation(automation, now)
  }
}

export function getAutomationDefinitionOperations(
  owner: AutomationPersistence
): AutomationDefinitionOperations {
  return {
    state: owner[automationPersistenceContext].runtime.state,
    storageAuthority: owner[automationPersistenceContext].runtime.storageAuthority,
    flush: () => owner[automationPersistenceContext].flushBarriers.flush(),
    recordCreated: () =>
      owner[automationPersistenceContext].preferences.recordFeatureInteraction('automation-created')
  }
}

export function getAutomationRunOperations(owner: AutomationPersistence): AutomationRunOperations {
  return {
    state: owner[automationPersistenceContext].runtime.state,
    flush: () => owner[automationPersistenceContext].flushBarriers.flush(),
    recordManualRun: () =>
      owner[automationPersistenceContext].preferences.recordFeatureInteraction('automation-run'),
    getWorkspaceDisplayName: (workspaceId) =>
      getAutomationRunWorkspaceDisplayName(owner, workspaceId)
  }
}

export function getAutomationRunWorkspaceDisplayName(
  owner: AutomationPersistence,
  workspaceId: string | null | undefined
): string | null {
  if (!workspaceId) {
    return null
  }
  return normalizeAutomationRunWorkspaceDisplayName(
    owner[automationPersistenceContext].runtime.state.worktreeMeta[workspaceId]?.displayName ??
      getWorktreePathBasenameFromId(workspaceId)
  )
}

export function installAutomationPersistenceContext(
  target: object,
  source: AutomationPersistence
): void {
  Object.defineProperty(target, automationPersistenceContext, {
    value: source[automationPersistenceContext]
  })
}
