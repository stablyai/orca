import { randomUUID } from 'node:crypto'
import {
  createLocalLiveCatalogPaths,
  type LiveCatalogSourcePaths
} from './orcad-live-catalog-paths-fixture'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'
import type { SshPtyConsumerRecovery } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { ptyOwnership, ptyIncarnationById } from '../ipc/pty/provider/ownership-state'
import type { installLiveSourceModel } from './orcad-live-source-model-fixture'

type LiveSource = ReturnType<typeof installLiveSourceModel>
type SourceIdentity = NonNullable<
  ReturnType<LiveSource['provider']['getOwnershipTransferSourceIdentity']>
>

export async function createLiveCatalogSource(options: {
  directory: string
  paths?: LiveCatalogSourcePaths
  store: Store
  runtime: OrcaRuntimeService
  source: LiveSource
  targetId: string
  owner: Omit<SshPtyConsumerRecovery, 'targetId'>
}) {
  const { directory, store, runtime, source, targetId, owner } = options
  const { repoPath, worktreePath, folderPath } =
    options.paths ?? (await createLocalLiveCatalogPaths(directory))
  const group = store.createProjectGroup({
    name: 'Live migration source',
    parentPath: directory,
    connectionId: targetId,
    createdFrom: 'manual'
  })
  const repoId = randomUUID()
  store.addRepo({
    id: repoId,
    path: repoPath,
    displayName: 'Live migration repository',
    badgeColor: '#737373',
    addedAt: Date.now(),
    connectionId: targetId,
    executionHostId: `ssh:${targetId}`,
    projectGroupId: group.id
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'Live migration folder',
    folderPath,
    connectionId: targetId
  })
  const host = `ssh:${targetId}` as const
  const session = store.getWorkspaceSession(host)
  const terminals: {
    workspaceKey: ReturnType<typeof folderWorkspaceKey | typeof worktreeWorkspaceKey>
    tabId: string
    leafId: string
    ptyId: string
    identity: SourceIdentity
    handle: string
    cwd: string
  }[] = []
  const cleanupRoutes = () => {
    for (const terminal of terminals) {
      if (
        ptyOwnership.get(terminal.ptyId) === targetId &&
        ptyIncarnationById.get(terminal.ptyId) === terminal.identity.incarnationId
      ) {
        ptyOwnership.delete(terminal.ptyId)
        ptyIncarnationById.delete(terminal.ptyId)
      }
    }
  }
  try {
    for (const placement of [
      {
        workspaceKey: folderWorkspaceKey(folder.id),
        ownerKey: folderWorkspaceKey(folder.id),
        cwd: folderPath
      },
      {
        workspaceKey: worktreeWorkspaceKey(`${repoId}::${worktreePath}`),
        ownerKey: `${repoId}::${worktreePath}`,
        cwd: worktreePath
      }
    ]) {
      const tabId = randomUUID()
      const leafId = randomUUID()
      const handle = runtime.createPreAllocatedTerminalHandle()
      const spawned = await source.provider.spawn({
        cwd: placement.cwd,
        shellOverride: '/bin/sh',
        cols: 80,
        rows: 24,
        env: { PS1: '', ENV: '/dev/null', ORCA_TERMINAL_HANDLE: handle }
      })
      const identity = source.provider.getOwnershipTransferSourceIdentity(spawned.id)
      if (!identity) {
        throw new Error('fixture_source_identity_missing')
      }
      terminals.push({ ...placement, tabId, leafId, ptyId: spawned.id, identity, handle })
      runtime.registerPty(spawned.id, placement.ownerKey, targetId, {
        tabId,
        leafId,
        incarnationId: spawned.incarnationId
      })
      runtime.registerPreAllocatedHandleForPty(spawned.id, handle)
      ptyOwnership.set(spawned.id, targetId)
      ptyIncarnationById.set(spawned.id, identity.incarnationId)
      session.tabsByWorktree[placement.ownerKey] = [
        {
          id: tabId,
          ptyId: spawned.id,
          worktreeId: placement.ownerKey,
          title: 'Live shell',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: Date.now()
        }
      ]
      session.terminalLayoutsByTabId[tabId] = {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: spawned.id }
      }
      session.terminalPtyIncarnationsByPaneKey ??= {}
      session.terminalPtyIncarnationsByPaneKey[`${tabId}:${leafId}`] = identity.incarnationId
      store.upsertSshRemotePtyLease({
        targetId,
        ptyId: identity.terminalId,
        worktreeId: placement.ownerKey,
        tabId,
        leafId,
        state: 'attached'
      })
    }
    store.setWorkspaceSession(session, host)
    await store.upsertSshPtyConsumerRecovery({ ...owner, targetId })
    source.ready()
    return { terminals, cleanupRoutes, groupId: group.id, repoId, folderId: folder.id }
  } catch (error) {
    cleanupRoutes()
    throw error
  }
}
