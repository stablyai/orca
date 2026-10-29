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

export type AutomationOwnerClassification = 'owned' | 'orphan' | 'ambiguous'

/** Use the authority’s persisted registry; runtime-owned records are ambiguous desktop mirrors. */
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

/** Never overwrite a capture: a different generation may belong to a replacement host. */
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

/** Workspace-pinned local records need the SSH registration’s generation too. */
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
    // Follow a valid workspace repin before checking for an orphan.
    const record = followWorkspaceRepin(automation, pin, sshTargetIdForGeneration)
    const classification = classifyAutomationOwner(record, knownIds, pin, storageAuthority)
    // Dispatch refuses unowned records; migration must not adopt them.
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
