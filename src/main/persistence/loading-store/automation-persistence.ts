import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunTrigger,
  AutomationUpdateInput
} from '../../../shared/automations-types'
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
  snapshotAutomationRunWorkspaceDisplayName as snapshotAutomationRunWorkspaceDisplayNameOperation,
  updateAutomationRun as updateAutomationRunOperation,
  type AutomationRunOperations
} from '../scheduling-automations/automation-run-operations'
import {
  advanceAutomationNextRun as advanceAutomationNextRunOperation,
  getLatestAutomationOccurrence as getLatestAutomationOccurrenceOperation
} from '../scheduling-automations/automation-schedule-operations'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteFlushBarrierOperations } from './write-flush-barriers'
import type { ProfilePreferences } from './profile-preferences'

type AutomationPersistenceRuntime = Pick<StoreRuntimeState, 'state'>

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

  listAutomationRuns(automationId?: string): AutomationRun[] {
    return listAutomationRunsOperation(
      this[automationPersistenceContext].runtime.state,
      automationId
    )
  }

  createAutomation(input: AutomationCreateInput): Automation {
    return createAutomationOperation(getAutomationDefinitionOperations(this), input)
  }

  updateAutomation(id: string, updates: AutomationUpdateInput): Automation {
    return updateAutomationOperation(getAutomationDefinitionOperations(this), id, updates)
  }

  deleteAutomation(id: string): void {
    deleteAutomationOperation(getAutomationDefinitionOperations(this), id)
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
