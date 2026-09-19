import { z } from 'zod'
import type { Store } from '../persistence'
import type {
  OrcadLiveMigrationRendererPlan,
  OrcadLiveMigrationRendererPlanSelection
} from '../../shared/orcad-live-migration-renderer-plan'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { validateOrcadLiveCompletedRecovery } from './orcad-live-completed-recovery'
import { getActiveSidebarWorkspaceId } from '../../shared/workspace-scope'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../shared/workspace-session-host-field-ownership'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from '../persistence/migrating-orcad-catalog/orcad-source-scope'

export const orcadLiveMigrationRendererPlanSelectionSchema = z.object({
  selector: z.string().trim().min(1).max(1024),
  migrationId: z.string().min(1).max(1024)
})

/** Read-only projection of completed main-owned evidence, never renderer-supplied proof. */
export function getOrcadLiveMigrationRendererPlan(
  profileDirectory: string,
  store: Pick<Store, 'getOrcadLiveMigrationRendererEvidence'>,
  selection: OrcadLiveMigrationRendererPlanSelection
): OrcadLiveMigrationRendererPlan {
  const args = orcadLiveMigrationRendererPlanSelectionSchema.parse(selection)
  const environment = resolveEnvironment(profileDirectory, args.selector)
  const { record, completed } = store.getOrcadLiveMigrationRendererEvidence(args.migrationId)
  const { cutover } = record.release
  if (cutover.manifest.migrationId !== args.migrationId) {
    throw new Error('orcad_live_renderer_plan_retirement_missing')
  }
  if (
    !environment.runtimeId ||
    cutover.destinationEnvironmentId !== environment.id ||
    cutover.liveTerminalBindings!.some(
      ({ identity }) => identity.destinationRuntimeId !== environment.runtimeId
    )
  ) {
    throw new Error('orcad_live_migration_destination_changed')
  }
  const retained = validateOrcadLiveCompletedRecovery(profileDirectory, completed)
  if (retained.record.sha256 !== record.sha256) {
    throw new Error('orcad_live_renderer_plan_evidence_changed')
  }
  const { manifest } = cutover
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  const workspaces = new Map<string, OrcadLiveMigrationRendererPlan['workspaces'][number]>()
  const add = (value: string) => {
    const raw = unqualifyOrcadMigrationOwnerKey(value)
    const workspaceId = getActiveSidebarWorkspaceId(raw, raw)!
    if (orcadMigrationOwnerMatchesScope(workspaceId, scope) && !workspaces.has(workspaceId)) {
      workspaces.set(workspaceId, { workspaceId, terminals: [] })
    }
  }
  for (const folder of manifest.payload.folderWorkspaces) {
    add(`folder:${folder.id}`)
  }
  const dormant = manifest.payload.dormantState
  for (const row of dormant?.worktreeMeta ?? []) {
    add(row.worktreeId)
  }
  for (const row of dormant?.worktreeLineage ?? []) {
    add(row.worktreeId)
  }
  for (const row of dormant?.workspaceLineage ?? []) {
    add(row.childWorkspaceKey)
  }
  for (const [field, map] of Object.entries(dormant?.workspaceSession ?? {})) {
    if (
      WORKSPACE_SESSION_FIELD_OWNERSHIP[field as keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP] ===
        'worktreeKeyed' &&
      map &&
      typeof map === 'object' &&
      !Array.isArray(map)
    ) {
      for (const workspaceId of Object.keys(map)) {
        add(workspaceId)
      }
    }
  }
  for (const { identity, surfaceBinding } of cutover.liveTerminalBindings!) {
    const workspaceId = getActiveSidebarWorkspaceId(surfaceBinding.workspaceKey, null)!
    add(workspaceId)
    const workspace = workspaces.get(workspaceId)
    if (!workspace) {
      throw new Error('orcad_live_renderer_plan_workspace_missing')
    }
    workspace.terminals.push({
      tabId: surfaceBinding.tabId,
      leafId: surfaceBinding.leafId,
      sourcePtyId: toAppSshPtyId(manifest.source.sshTargetId, identity.terminalId),
      incarnationId: identity.incarnationId
    })
  }
  return {
    version: 1,
    migrationId: manifest.migrationId,
    retirementRecordSha256: record.sha256,
    sourceSshTargetId: manifest.source.sshTargetId,
    destinationEnvironmentId: environment.id,
    destinationRuntimeId: environment.runtimeId,
    sourceCatalog: {
      repoIds: manifest.payload.repositories.map(({ id }) => id),
      projectGroupIds: manifest.payload.projectGroups.map(({ id }) => id),
      folderWorkspaceIds: manifest.payload.folderWorkspaces.map(({ id }) => id)
    },
    workspaces: [...workspaces.values()]
  }
}
