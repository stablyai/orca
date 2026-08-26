import type { Automation } from '../../shared/automations-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import { parseExecutionHostId } from '../../shared/execution-host'
import {
  resolveAutomationWorkspaceSshTargetId,
  type AutomationWorkspaceSshPin
} from '../../shared/automation-workspace-pin'
import {
  isWorkspaceSshPinRepinned,
  type SshTargetIdForGeneration
} from '../../shared/automation-workspace-repin'
import type { FolderWorkspaceHostState } from '../../shared/folder-workspace-execution-host'
import {
  nextSshTargetGeneration,
  resolveSshTargetGenerationHighWaterMark,
  sanitizeSshTargetGeneration
} from '../../shared/ssh-target-generation'

/**
 * One idempotent load-time migration that gives every stored automation a
 * fenceable owner: generations are stamped on live targets, then automations
 * adopt or are classified. Running it twice changes nothing. Classification only
 * gates adoption here — refusing to run an orphan is dispatch's live verdict
 * (`resolveAutomationRunTarget`), not a persisted write this migration makes.
 */

export type AutomationOwnerClassification = 'owned' | 'orphan' | 'ambiguous'

/**
 * Runtime markers belong to a runtime store; the same markers are ambiguous desktop mirrors.
 *
 * `knownSshTargetIds` is the authority's own persisted registry, so a miss is
 * settled evidence rather than a list that has not loaded. `workspacePin` is
 * likewise only supplied once a workspace has been resolved: an absent pin means
 * nothing proves the record is pinned, never that its host is gone.
 */
export function classifyAutomationOwner(
  automation: Automation,
  knownSshTargetIds: ReadonlySet<string>,
  workspacePin?: AutomationWorkspaceSshPin,
  storageAuthority: 'desktop' | 'runtime' = 'desktop'
): AutomationOwnerClassification {
  if (
    storageAuthority !== 'runtime' &&
    (automation.schedulerOwner === 'remote_host_service' ||
      parseExecutionHostId(automation.runContext?.hostId)?.kind === 'runtime')
  ) {
    return 'ambiguous'
  }
  if (automation.executionTargetType !== 'ssh') {
    // The pin is where the run goes, so a pin this authority cannot vouch for is the same
    // unrunnable record dispatch refuses — classifying it `owned` left it enabled and editable.
    if (!workspacePin) {
      return 'owned'
    }
    const captured = sanitizeSshTargetGeneration(automation.executionTargetGeneration)
    return knownSshTargetIds.has(workspacePin.targetId) &&
      (captured === undefined || captured === workspacePin.generation)
      ? 'owned'
      : 'orphan'
  }
  return automation.executionTargetId && knownSshTargetIds.has(automation.executionTargetId)
    ? 'owned'
    : 'orphan'
}

export type AutomationOwnerMigrationInput = {
  automations: readonly Automation[]
  sshTargets: readonly SshTarget[]
  repos: readonly Repo[]
  /** Needed to resolve which SSH target a record's folder workspace pins it to. */
  folderWorkspaces?: readonly FolderWorkspace[]
  projectGroups?: readonly ProjectGroup[]
  sshTargetGenerationCounter?: number
  storageAuthority?: 'desktop' | 'runtime'
}

export type AutomationOwnerMigrationResult = {
  automations: Automation[]
  sshTargets: SshTarget[]
  sshTargetGenerationCounter: number
  changed: boolean
}

type StampedTargets = { targets: SshTarget[]; counter: number; changed: boolean }

function stampTargetGenerations(
  sshTargets: readonly SshTarget[],
  highWaterMark: number
): StampedTargets {
  let counter = highWaterMark
  let changed = false
  const targets = sshTargets.map((target) => {
    if (sanitizeSshTargetGeneration(target.generation) !== undefined) {
      return target
    }
    counter = nextSshTargetGeneration(counter)
    changed = true
    return { ...target, generation: counter }
  })
  return { targets, counter, changed }
}

type MigratedAutomations = { automations: Automation[]; changed: boolean }

/**
 * Only an absent capture is stamped: overwriting a differing one would re-adopt
 * the record onto the target that replaced the incarnation it was attached to.
 */
function stampCapturedGeneration(
  automation: Automation,
  ownerTargetId: string | undefined,
  targetsById: ReadonlyMap<string, SshTarget>
): Automation {
  const generation =
    ownerTargetId === undefined ? undefined : targetsById.get(ownerTargetId)?.generation
  if (
    generation === undefined ||
    sanitizeSshTargetGeneration(automation.executionTargetGeneration) !== undefined
  ) {
    return automation
  }
  return { ...automation, executionTargetGeneration: generation }
}

/**
 * A local record its workspace pins to SSH runs on that registration, so it is
 * fenced by it too — the pin owns the capture the way the selector does for SSH rows.
 */
function resolveWorkspacePin(
  automation: Automation,
  workspaceState: FolderWorkspaceHostState,
  targetsById: ReadonlyMap<string, SshTarget>
): AutomationWorkspaceSshPin | undefined {
  if (automation.executionTargetType === 'ssh') {
    return undefined
  }
  const targetId = resolveAutomationWorkspaceSshTargetId(workspaceState, automation.workspaceId)
  return targetId === undefined
    ? undefined
    : { targetId, generation: targetsById.get(targetId)?.generation }
}

/** A re-pinned workspace moved the record's host, so the capture moves with it. */
function followWorkspaceRepin(
  automation: Automation,
  pin: AutomationWorkspaceSshPin | undefined,
  sshTargetIdForGeneration: SshTargetIdForGeneration
): Automation {
  return isWorkspaceSshPinRepinned({
    capturedGeneration: automation.executionTargetGeneration,
    pin,
    sshTargetIdForGeneration
  })
    ? { ...automation, executionTargetGeneration: pin?.generation }
    : automation
}

function indexTargetsByGeneration(
  targetsById: ReadonlyMap<string, SshTarget>
): SshTargetIdForGeneration {
  const owners = new Map<number, string>()
  for (const target of targetsById.values()) {
    const generation = sanitizeSshTargetGeneration(target.generation)
    if (generation !== undefined) {
      owners.set(generation, target.id)
    }
  }
  return (generation) => owners.get(generation)
}

function migrateAutomations(
  automations: readonly Automation[],
  targetsById: ReadonlyMap<string, SshTarget>,
  workspaceState: FolderWorkspaceHostState,
  storageAuthority: 'desktop' | 'runtime'
): MigratedAutomations {
  const knownIds = new Set(targetsById.keys())
  const sshTargetIdForGeneration = indexTargetsByGeneration(targetsById)
  let changed = false
  const migrated = automations.map((automation) => {
    const pin = resolveWorkspacePin(automation, workspaceState, targetsById)
    // Before classification: a followed re-pin is a healthy record, not an orphan.
    const record = followWorkspaceRepin(automation, pin, sshTargetIdForGeneration)
    const classification = classifyAutomationOwner(record, knownIds, pin, storageAuthority)
    // Orphans and ambiguous records are never moved, rewritten to Self, stamped,
    // or deleted; dispatch refuses them live rather than this migration writing state.
    if (classification !== 'owned') {
      changed ||= record !== automation
      return record
    }
    const ownerTargetId =
      record.executionTargetType === 'ssh' ? record.executionTargetId : pin?.targetId
    const stamped = stampCapturedGeneration(record, ownerTargetId, targetsById)
    if (stamped !== automation) {
      changed = true
    }
    return stamped
  })
  return { automations: migrated, changed }
}

export function migrateAutomationOwners(
  input: AutomationOwnerMigrationInput
): AutomationOwnerMigrationResult {
  const highWaterMark = resolveSshTargetGenerationHighWaterMark({
    persistedCounter: input.sshTargetGenerationCounter,
    targetGenerations: input.sshTargets.map((target) => target.generation),
    capturedGenerations: input.automations.map((automation) => automation.executionTargetGeneration)
  })
  const stamped = stampTargetGenerations(input.sshTargets, highWaterMark)
  const targetsById = new Map(stamped.targets.map((target) => [target.id, target]))
  const migrated = migrateAutomations(
    input.automations,
    targetsById,
    {
      folderWorkspaces: [...(input.folderWorkspaces ?? [])],
      projectGroups: [...(input.projectGroups ?? [])],
      repos: [...input.repos]
    },
    input.storageAuthority ?? 'desktop'
  )
  return {
    automations: migrated.automations,
    sshTargets: stamped.targets,
    sshTargetGenerationCounter: stamped.counter,
    changed:
      stamped.changed ||
      migrated.changed ||
      // A rolled-back counter must be rewritten even when nothing else changed.
      stamped.counter !== (sanitizeSshTargetGeneration(input.sshTargetGenerationCounter) ?? 0)
  }
}
