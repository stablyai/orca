// "Move to this computer" for Orca Cloud workspaces: the IPC flow. Everything travels over the
// workspace's E2EE orcad connection; the control plane never sees repository content. prepare packs
// in the VM, downloads and imports the branch; finish (after the window created the local worktree
// through its ordinary create path) applies changes and installs remapped agent sessions.
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  CLOUD_TRANSFER_ARCHIVE,
  CLOUD_TRANSFER_MAX_BYTES
} from '../../shared/hosted-sandbox/cloud-transfer-pack'
import { safeExtractTar } from './cloud-transfer-tar'
import {
  applyTransferToWorktree,
  loadPersistedTransfer,
  persistTransfer
} from './cloud-transfer-apply'
import {
  discardPendingCloudTransfer,
  listPendingCloudTransfers,
  persistedWorktreePath,
  sweepCloudTransfers
} from './cloud-transfer-pending'
import {
  ORCA_CLOUD_TRANSFER_CHANNELS as CH,
  type CloudTransferFinished,
  type CloudTransferPending,
  type CloudTransferPhase,
  type CloudTransferPrepared,
  type CloudTransferProgressEvent,
  type CloudTransferResult
} from '../../shared/hosted-sandbox/cloud-transfer-api'
import {
  cleanUpCloud,
  downloadCloudFile,
  importBundle,
  packInCloud,
  pickCloudWorktree,
  type Prepared,
  WorktreeListingSchema
} from './cloud-transfer-steps'
import { createHostedRuntimeEnvironmentCall } from './hosted-runtime-environment-call'
import { findCloudRuntime } from './hosted-workspace-service'

export { importBundle, installSessions, pickCloudWorktree } from './cloud-transfer-steps'
export { listPendingCloudTransfers, sweepCloudTransfers } from './cloud-transfer-pending'

export function installCloudTransferHandlers(deps: {
  userDataPath: string
  windows: () => readonly BrowserWindow[]
  /** Claude/Codex homes on this desktop (tests point them at temp dirs). */
  claudeHome?: string
  codexHome?: string
}): () => void {
  const prepared = new Map<string, Prepared>()
  // One apply at a time per transfer (finish and "Apply changes again" share it).
  const applying = new Set<string>()
  const busy = <T>(): CloudTransferResult<T> => ({
    ok: false,
    code: 'busy',
    message: 'Changes from this move are already being applied.'
  })
  const claudeHome = deps.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const codexHome = deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const emit = (event: Omit<CloudTransferProgressEvent, 'at'>): void => {
    for (const window of deps.windows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(CH.progress, {
          ...event,
          at: Date.now()
        } satisfies CloudTransferProgressEvent)
      }
    }
  }
  const fail = <T>(
    workspaceId: string,
    transferId: string | null,
    error: unknown
  ): CloudTransferResult<T> => {
    const message = error instanceof Error ? error.message : String(error)
    emit({ workspaceId, transferId, phase: 'failed', message })
    return { ok: false, code: 'failed', message }
  }

  void sweepCloudTransfers(join(deps.userDataPath, 'cloud-transfers'), Date.now()).catch(
    () => undefined
  )
  ipcMain.removeHandler(CH.prepare)
  ipcMain.removeHandler(CH.finish)
  ipcMain.removeHandler(CH.reapply)
  ipcMain.removeHandler(CH.listPending)
  ipcMain.removeHandler(CH.discardPending)
  ipcMain.handle(
    CH.prepare,
    async (
      _event,
      args: { workspaceId: string; destination?: { repoId?: string } }
    ): Promise<CloudTransferResult<CloudTransferPrepared>> => {
      const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
      if (!found) {
        return { ok: false, code: 'not_cloud', message: 'Not an Orca Cloud workspace.' }
      }
      const { runtime } = found
      if (runtime.status !== 'running' || !runtime.runtimeEnvironmentId) {
        // The window wakes first through its ordinary wake path, then retries.
        return { ok: false, code: 'asleep', message: 'Wake the workspace before moving it.' }
      }
      const repoId = args.destination?.repoId ?? runtime.repoId
      const repoPath = runtime.repoPath
      if (!repoId || !repoPath) {
        return {
          ok: false,
          code: 'no_local_repo',
          message: 'This workspace has no local project to move into.'
        }
      }
      const transferId = randomUUID()
      const step = (
        phase: CloudTransferPhase,
        extra: Partial<CloudTransferProgressEvent> = {}
      ): void => emit({ workspaceId: args.workspaceId, transferId, phase, ...extra })
      const dir = join(deps.userDataPath, 'cloud-transfers', transferId)
      const call = createHostedRuntimeEnvironmentCall(
        deps.userDataPath,
        runtime.runtimeEnvironmentId
      )
      let selector: string | null = null
      try {
        step('packing')
        const listing = WorktreeListingSchema.parse(await call('worktree.list', {}))
        const connection = runtime.recipeResult
          ? getEphemeralVmRecipeResultConnection(runtime.recipeResult)
          : null
        const projectRoot = connection?.type === 'orca-server' ? connection.projectRoot : null
        const worktree = pickCloudWorktree(listing.worktrees ?? [], args.workspaceId, projectRoot)
        if (!worktree) {
          throw new Error('Could not find the workspace on the cloud host.')
        }
        selector = `id:${worktree.id}`
        const { manifest, archiveBytes } = await packInCloud(call, selector)
        step('downloading', { bytes: 0, totalBytes: archiveBytes })
        await mkdir(dir, { recursive: true })
        const tarPath = join(dir, 'transfer.tar')
        const total = await downloadCloudFile(
          call,
          selector,
          CLOUD_TRANSFER_ARCHIVE,
          tarPath,
          (bytes) => step('downloading', { bytes, totalBytes: archiveBytes })
        )
        step('importing', { bytes: total, totalBytes: total })
        // The VM's archive is untrusted: regular files and dirs only, no escapes, capped.
        await safeExtractTar(tarPath, dir, { maxBytes: CLOUD_TRANSFER_MAX_BYTES })
        await rm(tarPath, { force: true })
        const branch = manifest.hasBundle
          ? await importBundle(repoPath, join(dir, 'repo.bundle'), manifest)
          : null
        if (!branch) {
          throw new Error('The cloud workspace has no commits to move.')
        }
        const entry = { dir, manifest, repoPath, workspaceId: args.workspaceId }
        prepared.set(transferId, entry)
        await persistTransfer(entry)
        const baseBranch = manifest.upstream?.replace(/^[^/]+\//, '') ?? null
        return {
          ok: true,
          value: {
            transferId,
            repoId,
            branch,
            cloudBranch: manifest.branch,
            baseBranch,
            counts: {
              untrackedFiles: manifest.untrackedFiles,
              claudeSessions: manifest.claudeSessions,
              codexSessions: manifest.codexSessions,
              hasChanges:
                manifest.stagedBytes + manifest.unstagedBytes > 0 || manifest.untrackedFiles > 0
            }
          }
        }
      } catch (error) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        return fail(args.workspaceId, transferId, error)
      } finally {
        // The VM's scratch copy goes whether the move succeeded or not.
        if (selector) {
          await cleanUpCloud(call, selector)
        }
      }
    }
  )

  ipcMain.handle(
    CH.finish,
    async (
      _event,
      args: { transferId: string; worktreePath: string }
    ): Promise<CloudTransferResult<CloudTransferFinished>> => {
      const entry = prepared.get(args.transferId)
      if (!entry) {
        return { ok: false, code: 'not_found', message: 'That transfer is no longer available.' }
      }
      const step = (phase: CloudTransferPhase): void =>
        emit({ workspaceId: entry.workspaceId, transferId: args.transferId, phase })
      if (applying.has(args.transferId)) {
        return busy()
      }
      applying.add(args.transferId)
      try {
        step('applying')
        const finished = await applyTransferToWorktree(entry, args.worktreePath, {
          claudeHome,
          codexHome
        })
        // Kept in memory while something is left to apply, so "Apply changes again" can retry.
        if (!finished.leftoverPatchDir) {
          prepared.delete(args.transferId)
        }
        step('done')
        return { ok: true, value: finished }
      } catch (error) {
        return fail(entry.workspaceId, args.transferId, error)
      } finally {
        applying.delete(args.transferId)
      }
    }
  )
  ipcMain.handle(
    CH.reapply,
    async (
      _event,
      args: { transferId: string; worktreePath: string }
    ): Promise<CloudTransferResult<CloudTransferFinished>> => {
      // "Apply changes again": same worktree, never a new one. Works after a restart too (the
      // transfer folder records what it is), as long as the folder is still there.
      if (!/^[0-9a-f-]{36}$/i.test(args.transferId)) {
        return { ok: false, code: 'not_found', message: 'That transfer is no longer available.' }
      }
      const dir = join(deps.userDataPath, 'cloud-transfers', args.transferId)
      const entry = prepared.get(args.transferId) ?? (await loadPersistedTransfer(dir))
      const recorded = await persistedWorktreePath(dir)
      const worktreeOk = await stat(args.worktreePath).then(
        (s) => s.isDirectory(),
        () => false
      )
      // Only the worktree this transfer was first applied to: never another one the window names.
      if (!entry || !worktreeOk || (recorded !== null && recorded !== args.worktreePath)) {
        return { ok: false, code: 'not_found', message: 'That transfer is no longer available.' }
      }
      if (applying.has(args.transferId)) {
        return busy()
      }
      applying.add(args.transferId)
      try {
        emit({ workspaceId: entry.workspaceId, transferId: args.transferId, phase: 'applying' })
        const finished = await applyTransferToWorktree(entry, args.worktreePath, {
          claudeHome,
          codexHome
        })
        if (finished.leftoverPatchDir) {
          prepared.set(args.transferId, entry)
        } else {
          prepared.delete(args.transferId)
        }
        emit({ workspaceId: entry.workspaceId, transferId: args.transferId, phase: 'done' })
        return { ok: true, value: finished }
      } catch (error) {
        return fail(entry.workspaceId, args.transferId, error)
      } finally {
        applying.delete(args.transferId)
      }
    }
  )
  ipcMain.handle(CH.listPending, async (): Promise<CloudTransferPending[]> =>
    listPendingCloudTransfers(join(deps.userDataPath, 'cloud-transfers'))
  )
  ipcMain.handle(
    CH.discardPending,
    async (_event, args: { transferId: string }): Promise<boolean> =>
      applying.has(args.transferId)
        ? false
        : discardPendingCloudTransfer(join(deps.userDataPath, 'cloud-transfers'), args.transferId)
  )
  return () => {
    ipcMain.removeHandler(CH.prepare)
    ipcMain.removeHandler(CH.finish)
    ipcMain.removeHandler(CH.reapply)
    ipcMain.removeHandler(CH.listPending)
    ipcMain.removeHandler(CH.discardPending)
  }
}
