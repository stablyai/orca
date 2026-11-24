import type { Repo } from '../../../../shared/repository/repo-types'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../../shared/automations/automation-definition'
import type {
  AutomationDispatchResult,
  AutomationRun
} from '../../../../shared/automations/history/automation-run'
import type {
  AutomationCapturedHostIssue,
  AutomationChangeSelector,
  AutomationListParams,
  AutomationListResult
} from '../../../../shared/automations/ownership/automation-list-scope'
import type {
  AutomationDestination,
  AutomationOwnerFenceOperation,
  AutomationOwnerPrecondition,
  AutomationUpdatePreconditions
} from '../../../../shared/automations/ownership/automation-owner-precondition'
import type { WorkspaceRunContext } from '../../../../shared/work-items/task-source-context'
import type { AutomationRunEvent } from '../../../../shared/automation-event-triggers'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import {
  normalizeAutomationRunWorkspaceDisplayName,
  stampLegacyAutomationRunContext as stampLegacyAutomationRunContextOperation
} from '../../scheduling-automations/automation-context-migration'
import {
  createAutomation as createAutomationOperation,
  listAutomations as listAutomationsOperation,
  updateAutomation as updateAutomationOperation,
  type AutomationDefinitionOperations
} from '../../scheduling-automations/automation-definition-operations'
import { deleteAutomation as deleteAutomationOperation } from '../../scheduling-automations/automation-definition-removal'
import { foldAutomationEvent as foldAutomationEventOperation } from '../../scheduling-automations/automation-run-occurrence-folding'
import {
  updateAutomations as updateAutomationsOperation,
  type AutomationBatchUpdate,
  type AutomationBatchUpdateResult
} from '../../scheduling-automations/automation-definition-update'
import {
  createAutomationRun as createAutomationRunOperation,
  listAutomationRuns as listAutomationRunsOperation,
  listAutomationRunsByAutomation as listRunsByAutomationOperation,
  listAutomationRunsPage as listAutomationRunsOperationPage,
  recordRepeatedAutomationSkip as recordRepeatedAutomationSkipOperation,
  snapshotAutomationRunWorkspaceDisplayName as snapshotAutomationRunWorkspaceDisplayNameOperation,
  updateAutomationRun as updateAutomationRunOperation,
  type AutomationRunOperations
} from '../../scheduling-automations/automation-run-operations'
import {
  advanceAutomationNextRun as advanceAutomationNextRunOperation,
  disableAutomations as disableAutomationsOperation,
  getLatestAutomationOccurrence as getLatestAutomationOccurrenceOperation
} from '../../scheduling-automations/automation-schedule-operations'
import {
  assertAutomationOwnerFence as assertAutomationOwnerFenceOperation,
  automationCapturedHostIssue as automationCapturedHostIssueOperation,
  automationChangeSelector as automationChangeSelectorOperation,
  automationOwnerPrecondition as automationOwnerPreconditionOperation,
  listAutomationsForScope as listAutomationsForScopeOperation
} from '../../scheduling-automations/automation-owner-projection'

import type { StoreRuntimeState } from '../store-runtime-state'
import type { WriteFlushBarrierOperations } from '../profile-writing/write-flush-barriers'
import type { ProfilePreferences } from '../profile-preferences/profile-preferences'

type AutomationPersistenceRuntime = Pick<
  StoreRuntimeState,
  | 'automationListProjectionCache'
  | 'dirtyProfileStateDomains'
  | 'pendingAutomationRunsAfter'
  | 'state'
  | 'storageAuthority'
>

const automationPersistenceContext = Symbol('AutomationPersistence')
type AutomationPersistenceContext = {
  runtime: AutomationPersistenceRuntime
  flushBarriers: WriteFlushBarrierOperations
  preferences: ProfilePreferences
}

/** An operation's arguments after the operations it acts through. */
type ArgsAfterOperations<F> = F extends (operations: never, ...rest: infer R) => unknown ? R : never

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

  listAutomationRunsByAutomation(ids: readonly string[]): Map<string, AutomationRun[]> {
    return listRunsByAutomationOperation(this[automationPersistenceContext].runtime.state, ids)
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
    options?: { destination?: AutomationDestination; id?: string; resolvedRepo?: Repo }
  ): Automation {
    return createAutomationOperation(getAutomationDefinitionOperations(this), input, options)
  }

  updateAutomation(
    id: string,
    updates: AutomationUpdateInput,
    options?: AutomationUpdatePreconditions & { resolvedRepo?: Repo }
  ): Automation {
    return updateAutomationOperation(getAutomationDefinitionOperations(this), id, updates, options)
  }

  /** `updateAutomation` for many rows with one list write and one flush. */
  updateAutomations(batch: readonly AutomationBatchUpdate[]): AutomationBatchUpdateResult[] {
    return updateAutomationsOperation(getAutomationDefinitionOperations(this), batch)
  }

  stampLegacyAutomationRunContext(automationId: string, runContext: WorkspaceRunContext): boolean {
    return stampLegacyAutomationRunContextOperation(
      getAutomationDefinitionOperations(this),
      automationId,
      runContext
    )
  }

  deleteAutomation(id: string, options?: { expectedOwner?: AutomationOwnerPrecondition }): void {
    deleteAutomationOperation(getAutomationDefinitionOperations(this), id, options)
  }

  createAutomationRun(...args: ArgsAfterOperations<typeof createAutomationRunOperation>) {
    return createAutomationRunOperation(getAutomationRunOperations(this), ...args)
  }

  recordRepeatedAutomationSkip(
    ...args: ArgsAfterOperations<typeof recordRepeatedAutomationSkipOperation>
  ) {
    return recordRepeatedAutomationSkipOperation(getAutomationRunOperations(this), ...args)
  }

  foldAutomationEvent(automationId: string, event: AutomationRunEvent): AutomationRun | null {
    return foldAutomationEventOperation(getAutomationRunOperations(this), automationId, event)
  }

  updateAutomationRun(result: AutomationDispatchResult): AutomationRun {
    return updateAutomationRunOperation(getAutomationRunOperations(this), result)
  }

  snapshotAutomationRunWorkspaceDisplayName(
    target: HostWorktreeTarget,
    displayName: string
  ): number {
    return snapshotAutomationRunWorkspaceDisplayNameOperation(
      getAutomationRunOperations(this),
      target,
      displayName
    )
  }

  advanceAutomationNextRun(id: string, now = Date.now()): Automation {
    return advanceAutomationNextRunOperation(
      this[automationPersistenceContext].runtime.state,
      () => {
        markAutomationDefinitionDomain(this)
        this[automationPersistenceContext].flushBarriers.flush()
      },
      id,
      this[automationPersistenceContext].runtime.storageAuthority,
      now
    )
  }

  disableAutomations(ids: ReadonlySet<string>): number {
    return disableAutomationsOperation(
      this[automationPersistenceContext].runtime.state,
      () => {
        markAutomationDefinitionDomain(this)
        this[automationPersistenceContext].flushBarriers.flush()
      },
      ids
    )
  }

  getLatestAutomationOccurrence(automation: Automation, now = Date.now()): number | null {
    return getLatestAutomationOccurrenceOperation(
      automation,
      this[automationPersistenceContext].runtime.storageAuthority,
      now
    )
  }
}

export function getAutomationDefinitionOperations(
  owner: AutomationPersistence
): AutomationDefinitionOperations {
  return {
    state: owner[automationPersistenceContext].runtime.state,
    storageAuthority: owner[automationPersistenceContext].runtime.storageAuthority,
    flush: () => {
      markAutomationDefinitionDomain(owner)
      owner[automationPersistenceContext].flushBarriers.flush()
    },
    recordCreated: () =>
      owner[automationPersistenceContext].preferences.recordFeatureInteraction(
        'automation-created'
      ),
    recordAutomationRunsMutation: (runs) => {
      owner[automationPersistenceContext].runtime.pendingAutomationRunsAfter = runs
      owner[automationPersistenceContext].runtime.dirtyProfileStateDomains?.add('automationRuns')
    }
  }
}

export function getAutomationRunOperations(owner: AutomationPersistence): AutomationRunOperations {
  return {
    state: owner[automationPersistenceContext].runtime.state,
    flush: () => {
      markAutomationDomains(owner)
      owner[automationPersistenceContext].flushBarriers.flush()
    },
    recordAutomationRunsMutation: (runs) => {
      owner[automationPersistenceContext].runtime.pendingAutomationRunsAfter = runs
    },
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

function markAutomationDomains(owner: AutomationPersistence): void {
  const dirtyDomains = owner[automationPersistenceContext].runtime.dirtyProfileStateDomains
  if (dirtyDomains !== null) {
    dirtyDomains.add('automations')
    dirtyDomains.add('automationRuns')
  }
}

function markAutomationDefinitionDomain(owner: AutomationPersistence): void {
  owner[automationPersistenceContext].runtime.dirtyProfileStateDomains?.add('automations')
}
