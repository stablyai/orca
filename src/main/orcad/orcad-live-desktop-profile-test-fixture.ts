import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration-manifest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { Store } from '../persistence'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

export async function liveDesktopProfileFixture(
  profileDirectory: string,
  manifest: OrcadMigrationManifest
) {
  const sourceId = manifest.source.sshTargetId
  const executionHostId = `ssh:${sourceId}` as const
  const state = getDefaultPersistedState(profileDirectory)
  state.sshTargets = [
    {
      id: sourceId,
      label: manifest.source.targetLabel,
      generation: manifest.source.sshTargetGeneration ?? undefined,
      host: 'source.example.test',
      port: 22,
      username: 'test'
    }
  ]
  state.repos = manifest.payload.repositories.map((entry) => ({
    ...entry,
    connectionId: sourceId,
    executionHostId,
    projectGroupId: manifest.payload.projectGroups[0].id
  }))
  state.projectGroups = manifest.payload.projectGroups.map((entry) => ({
    ...entry,
    connectionId: sourceId
  }))
  state.folderWorkspaces = manifest.payload.folderWorkspaces.map((entry) => ({
    ...entry,
    connectionId: sourceId
  }))
  const surfaceBinding = preparation.surfacePublication.surfaceBinding
  const ptyId = toAppSshPtyId(sourceId, identity.terminalId)
  const session = structuredClone(manifest.payload.dormantState!.workspaceSession!)
  session.tabsByWorktree['folder:folder-1'][0].ptyId = ptyId
  session.terminalLayoutsByTabId[surfaceBinding.tabId].ptyIdsByLeafId = {
    [surfaceBinding.leafId]: ptyId
  }
  session.terminalPtyIncarnationsByPaneKey = {
    [`${surfaceBinding.tabId}:${surfaceBinding.leafId}`]: identity.incarnationId
  }
  state.workspaceSessionsByHostId = { [executionHostId]: session }
  mkdirSync(profileDirectory, { recursive: true })
  const dataFile = join(profileDirectory, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(state))
  const store = new Store({ dataFile })
  store.upsertSshRemotePtyLease({
    targetId: sourceId,
    ptyId: identity.terminalId,
    worktreeId: 'folder:folder-1',
    tabId: surfaceBinding.tabId,
    leafId: surfaceBinding.leafId,
    state: 'attached'
  })
  await store.upsertSshPtyConsumerRecovery({
    targetId: sourceId,
    clientInstanceId: 'desktop',
    serverBuildId: 'build',
    clientGeneration: 1,
    ownerGeneration: identity.sourceOwnerGeneration,
    ownerLease: identity.ownerLease
  })
  const provider = {
    providerGeneration: 1,
    getOwnershipTransferSourceIdentity: () => identity,
    fenceOutgoingCatalogCreation: vi.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted()
    }),
    requestHostRpc: vi.fn(async () => {
      throw new Error('saved capture must not reprepare source')
    })
  }
  const runtime = {
    bindOutgoingSshPtyCatalogSurfaces: () => ({
      surfaces: [{ ptyId, incarnationId: identity.incarnationId, surfaceBinding }],
      assertCurrent: () => {}
    }),
    serializeSshPtyOwnershipCapture: vi.fn(async (): Promise<never> => {
      throw new Error('saved capture must not recapture')
    })
  }
  return { store, provider, runtime, sourceId, surfaceBinding, dataFile }
}
