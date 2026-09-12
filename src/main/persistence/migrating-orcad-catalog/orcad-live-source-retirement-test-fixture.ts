import { vi } from 'vitest'
import { createManagedOrcadSshOwner } from '../../../shared/managed-orcad-ssh-owner'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { parseOrcadMigrationSourceCutover } from '../../../shared/orcad-migration-source-cutover'
import { receipt } from '../../orcad-migration-source-cutover-test-fixture'
import {
  terminalLayoutAdmissionFixture,
  sealAdmissionManifest
} from './orcad-terminal-layout-admission-test-fixture'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { projectOrcadSourceLiveState } from './orcad-source-live-state-projection'
import { buildOrcadLiveSourceRetirementCandidate } from './orcad-live-source-retirement-candidate'

export function liveSourceRetirementFixture(
  kind: 'folder' | 'worktree' = 'folder',
  sourceTargetId = 'ssh-1',
  mirrorLocal = false
) {
  const f = terminalLayoutAdmissionFixture(kind, sourceTargetId)
  const { state } = f
  const bindings = f.bindings.map((binding) => ({
    ...binding,
    identity: { ...binding.identity, ownerLease: 'owner' }
  }))
  const targetId = f.manifest.source.sshTargetId
  const hostId = `ssh:${targetId}` as const
  state.sshTargets = [
    {
      id: targetId,
      label: 'Host',
      generation: 1,
      host: 'example.com',
      port: 22,
      username: 'user',
      owner: createManagedOrcadSshOwner('environment')
    }
  ]
  state.repos = f.manifest.payload.repositories.map((repo) => ({ ...repo, connectionId: targetId }))
  state.projectGroups = f.manifest.payload.projectGroups.map((group) => ({
    ...group,
    connectionId: targetId
  }))
  state.folderWorkspaces = f.manifest.payload.folderWorkspaces.map((folder) => ({
    ...folder,
    connectionId: targetId
  }))
  const session = structuredClone(f.manifest.payload.dormantState!.workspaceSession!)
  const layout = session.terminalLayoutsByTabId['tab-1']
  layout.ptyIdsByLeafId = {}
  session.terminalPtyIncarnationsByPaneKey = {}
  for (const { identity, surfaceBinding } of bindings) {
    layout.ptyIdsByLeafId[surfaceBinding.leafId] = toAppSshPtyId(targetId, identity.terminalId)
    session.terminalPtyIncarnationsByPaneKey[`tab-1:${surfaceBinding.leafId}`] =
      identity.incarnationId
  }
  session.tabsByWorktree[f.owner][0].ptyId = toAppSshPtyId(
    targetId,
    bindings[0].identity.terminalId
  )
  state.workspaceSessionsByHostId = { [hostId]: session }
  if (mirrorLocal) {
    state.workspaceSession = structuredClone(session)
    state.workspaceSession.activeConnectionIdsAtShutdown = [targetId]
  }
  state.sshRemotePtyLeases = bindings.map(({ identity, surfaceBinding }) => ({
    targetId,
    ptyId: identity.terminalId,
    worktreeId: f.owner,
    tabId: 'tab-1',
    leafId: surfaceBinding.leafId,
    state: 'attached',
    createdAt: 1,
    updatedAt: 1
  }))
  const recovery = {
    targetId,
    clientInstanceId: 'client',
    serverBuildId: 'build',
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'owner'
  }
  state.sshPtyConsumerRecoveries = [recovery]
  const evidence = structuredClone({ bindings, leases: state.sshRemotePtyLeases, recovery })
  const project = (
    state: Parameters<typeof projectOrcadSourceLiveState>[0],
    source: Parameters<typeof projectOrcadSourceLiveState>[1],
    catalog: Parameters<typeof projectOrcadSourceLiveState>[2]
  ) => projectOrcadSourceLiveState(state, source, catalog, evidence)
  const catalog = {
    repositories: state.repos,
    projectGroups: state.projectGroups,
    folderWorkspaces: state.folderWorkspaces
  }
  const dormant = collectOrcadMigrationSourceDormantState(
    project(state, f.manifest.source, catalog),
    f.manifest.source,
    catalog,
    undefined,
    'environment'
  )
  const manifest = sealAdmissionManifest({
    ...f.manifest,
    destinationEnvironmentId: 'environment',
    payload: { ...catalog, dormantState: dormant.payload }
  })
  const cutover = parseOrcadMigrationSourceCutover({
    version: 2,
    phase: 'destination-committed',
    manifest,
    destinationEnvironmentId: 'environment',
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    receipt: receipt(manifest),
    liveTerminalBindings: bindings,
    terminalPublications: bindings.map(({ identity, surfaceBinding }, index) => ({
      identity,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 },
      publicationReceipt: {
        version: 1,
        publicationReceiptId: `publication-${index}`,
        bridgeId: identity.bridgeId,
        destinationRuntimeId: identity.destinationRuntimeId,
        surfaceBinding,
        publishedAt: manifest.createdAt,
        commitReceipt: {
          bridgeId: identity.bridgeId,
          receiptId: `commit-${index}`,
          acceptedSourceEndSeq: 1,
          committedAt: manifest.createdAt
        }
      }
    }))
  })
  state.orcadMigrationSourceCutovers = [structuredClone(cutover)]
  const sourceAdmission = {
    assertBindings: vi.fn<() => void>(),
    assertCurrent: vi.fn<() => void>(),
    projectSourceState: vi.fn(project)
  }
  const run = () => buildOrcadLiveSourceRetirementCandidate({ state, cutover, sourceAdmission })
  return { state, cutover, sourceAdmission, run, hostId }
}
