// "Move to this computer" for Orca Cloud workspaces: the IPC flow. Everything travels over the
// workspace's E2EE orcad connection; the control plane never sees repository content. prepare packs
// in the VM, downloads and imports the branch; finish (after the window created the local worktree
// through its ordinary create path) applies changes and installs remapped agent sessions.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { getEphemeralVmRecipeResultConnection } from '../../shared/ephemeral-vm-recipes'
import {
  CLOUD_TRANSFER_ARCHIVE,
  CLOUD_TRANSFER_MAX_BYTES,
  claudeProjectDirName
} from '../../shared/hosted-sandbox/cloud-transfer-pack'
import { gunzipCapped, safeExtractTar } from './cloud-transfer-tar'
import {
  ORCA_CLOUD_TRANSFER_CHANNELS as CH,
  type CloudTransferFinished,
  type CloudTransferPhase,
  type CloudTransferPrepared,
  type CloudTransferProgressEvent,
  type CloudTransferResult
} from '../../shared/hosted-sandbox/cloud-transfer-api'
import {
  applyPatch,
  cleanUpCloud,
  downloadCloudFile,
  fileSize,
  importBundle,
  installSessions,
  listFiles,
  packInCloud,
  pickCloudWorktree,
  type Prepared,
  type WorktreeRow
} from './cloud-transfer-steps'
import { createHostedRuntimeEnvironmentCall } from './hosted-runtime-environment-call'
import { findCloudRuntime } from './hosted-workspace-service'

export { importBundle, installSessions, pickCloudWorktree } from './cloud-transfer-steps'

export function installCloudTransferHandlers(deps: {
  userDataPath: string
  windows: () => readonly BrowserWindow[]
  /** Claude/Codex homes on this desktop (tests point them at temp dirs). */
  claudeHome?: string
  codexHome?: string
}): () => void {
  const prepared = new Map<string, Prepared>()
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
        const listing = (await call('worktree.list', {})) as { worktrees?: WorktreeRow[] }
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
        prepared.set(transferId, { dir, manifest, repoPath, workspaceId: args.workspaceId })
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
      try {
        step('applying')
        const leftovers = join(entry.dir, 'unapplied')
        const appliedStaged = await applyPatch(
          args.worktreePath,
          join(entry.dir, 'staged.patch'),
          true,
          leftovers
        )
        const appliedUnstaged = await applyPatch(
          args.worktreePath,
          join(entry.dir, 'unstaged.patch'),
          false,
          leftovers
        )
        if ((await fileSize(join(entry.dir, 'untracked.tgz'))) > 0) {
          // Inflate with a cap (no gzip bombs), then extract without clobbering the branch's files.
          const untrackedTar = join(entry.dir, 'untracked.tar')
          await gunzipCapped(
            join(entry.dir, 'untracked.tgz'),
            untrackedTar,
            CLOUD_TRANSFER_MAX_BYTES
          )
          await safeExtractTar(untrackedTar, args.worktreePath, {
            maxBytes: CLOUD_TRANSFER_MAX_BYTES,
            noClobber: true
          })
          await rm(untrackedTar, { force: true })
        }
        const claudeSessions = await installSessions(
          join(entry.dir, 'claude'),
          join(claudeHome, 'projects', claudeProjectDirName(args.worktreePath)),
          entry.manifest.root,
          args.worktreePath
        )
        const codexSessions = await installSessions(
          join(entry.dir, 'codex'),
          join(codexHome, 'sessions'),
          entry.manifest.root,
          args.worktreePath
        )
        const kept = (await listFiles(leftovers)).length > 0
        if (!kept) {
          await rm(entry.dir, { recursive: true, force: true })
        }
        prepared.delete(args.transferId)
        step('done')
        return {
          ok: true,
          value: {
            worktreePath: args.worktreePath,
            appliedStaged,
            appliedUnstaged,
            untrackedFiles: entry.manifest.untrackedFiles,
            claudeSessions,
            codexSessions,
            leftoverPatchDir: kept ? leftovers : null
          }
        }
      } catch (error) {
        return fail(entry.workspaceId, args.transferId, error)
      }
    }
  )
  return () => {
    ipcMain.removeHandler(CH.prepare)
    ipcMain.removeHandler(CH.finish)
  }
}

const LEFTOVER_TTL_MS = 30 * 86_400_000

/**
 * Prepared transfers live only in memory, so anything on disk at startup is abandoned: removed,
 * except saved patches that did not apply (the user's work), which are kept for 30 days.
 */
export async function sweepCloudTransfers(root: string, now: number): Promise<number> {
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) {
      continue
    }
    const dir = join(root, entry.name)
    const leftovers = await stat(join(dir, 'unapplied')).catch(() => null)
    if (leftovers && now - leftovers.mtimeMs < LEFTOVER_TTL_MS) {
      continue
    }
    await rm(dir, { recursive: true, force: true })
    removed++
  }
  return removed
}
