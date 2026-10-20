import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { DEFAULT_REPO_BADGE_COLOR } from '../../../shared/constants'
import { getGitCloneFailureMessage } from '../../../shared/git-clone-failure-message'
import { gitSpawnAfterWindowsEnvironmentReady, promptGuardGitEnv } from '../../git/runner'
import { reuseSavedCloneTarget } from '../../git/saved-clone-target'
import { getRepoName } from '../../git/repo'
import type { ClaimedCloneTarget } from '../../git/repo-clone-path'
import {
  cleanupClaimedCloneTarget,
  claimCloneTarget,
  deriveValidatedClonePath,
  getClonePathComparisonKey
} from '../../git/repo-clone-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'
import { runWithClonePathLock } from './clone-path-lock'
import {
  awaitPendingCloneAbortCleanup,
  markCloneAbortCleanupPending,
  settleCloneAbortCleanup,
  type ActiveCloneMetadata
} from './clone-abort-cleanup'
import { RepositoryAddScriptRequestIpcArg } from './repo-ipc-arg-schemas'
import {
  openRepositoryAddScriptRequestScope,
  type RepositoryAddScriptCollectorSource
} from '../../repository-add-scripts/repository-add-script-request-scope'
import { reportNewGitRepository } from '../../repository-add-scripts/new-git-repository-observer'
import type {
  RepositoryAddScriptRequest,
  RepoWithRepositoryAddScriptPreview
} from '../../../shared/repository-add-script-types'
import { resolveClonedFolderConversion } from '../../folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../../folder-workspace-meta-presence'

// Why: module-scoped so the abort handle survives macOS window re-creation, when registerRepoHandlers re-runs.
let activeClone: ActiveCloneMetadata | null = null
const pendingLocalCloneControllers = new Set<AbortController>()
let nextCloneGeneration = 1
const latestCloneGenerationByPath = new Map<string, number>()

function emitCloneProgressFromText(mainWindow: BrowserWindow, text: string): void {
  for (const line of text.split(/[\r\n]+/)) {
    const match = line.match(/^([\w\s]+):\s+(\d+)%/)
    if (match && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('repos:clone-progress', {
        phase: match[1].trim(),
        percent: Number.parseInt(match[2], 10)
      })
    }
  }
}

async function cleanupOwnedCloneTarget(metadata: ActiveCloneMetadata): Promise<void> {
  if (!metadata.claimedTarget.canCleanup || !metadata.claimedTarget.ownedDirectoryIdentity) {
    return
  }
  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  // Why: a fast retry may attach a newer process before the aborted one closes; the old close handler must not delete it.
  if (
    activeClone &&
    activeClone.process !== metadata.process &&
    activeClone.pathKey === metadata.pathKey
  ) {
    return
  }

  if (latestCloneGenerationByPath.get(metadata.pathKey) !== metadata.generation) {
    return
  }
  await cleanupClaimedCloneTarget(metadata.path, metadata.claimedTarget)
}

export function registerRepoCloneHandlers(
  mainWindow: BrowserWindow,
  store: Store,
  addScripts: RepositoryAddScriptCollectorSource
): void {
  ipcMain.handle('repos:cloneAbort', async () => {
    for (const controller of pendingLocalCloneControllers) {
      controller.abort()
    }
    pendingLocalCloneControllers.clear()
    if (activeClone) {
      const clone = activeClone
      clone.abortRequested = true
      markCloneAbortCleanupPending(clone)
      clone.process.kill()
      activeClone = null
    }
  })

  ipcMain.handle(
    'repos:clone',
    async (
      _event,
      args: {
        url: string
        destination: string
        repositoryAddScriptPreview?: RepositoryAddScriptRequest
      }
    ): Promise<Repo | RepoWithRepositoryAddScriptPreview> => {
      const request = RepositoryAddScriptRequestIpcArg.safeParse(args.repositoryAddScriptPreview)
      if (!request.success) {
        throw new Error('invalid_repository_add_script_request')
      }
      const scope = openRepositoryAddScriptRequestScope(addScripts, request.data)
      // Why: derive the repo folder name from the URL's last segment, matching default git clone behavior.
      const clonePath = deriveValidatedClonePath(args)
      const clonePathKey = getClonePathComparisonKey(clonePath)
      // Remote projects can share this path string without belonging to this clone host.
      const findSaved = (): Repo | undefined =>
        store
          .getRepos()
          .find(
            (r) =>
              getClonePathComparisonKey(r.path) === clonePathKey &&
              getRepoExecutionHostId(r) === LOCAL_EXECUTION_HOST_ID
          )
      const finalizeReusedClone = async (reused: Repo): Promise<Repo> => {
        await prepareLocalWorktreeRootForRepo(store, reused)
        invalidateAuthorizedRootsCache()
        notifyReposChanged(mainWindow)
        emitRepoAdded('clone_url', true, true)
        return reused
      }
      const clonedRepo = await runWithClonePathLock(clonePathKey, async () => {
        await awaitPendingCloneAbortCleanup(clonePathKey)
        const cloneMetadataRef: { current: ActiveCloneMetadata | null } = { current: null }
        let claimedTarget: ClaimedCloneTarget
        let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
        // Why: registered before the saved-project check so Cancel also stops that git read.
        const pendingController = new AbortController()
        pendingLocalCloneControllers.add(pendingController)
        try {
          const reused = await reuseSavedCloneTarget(
            findSaved,
            args.url,
            LOCAL_EXECUTION_HOST_ID,
            pendingController.signal
          )
          if (reused) {
            // Why: clone_url always produces a git repo.
            emitRepoAdded('clone_url', true, true)
            return reused
          }
          // Why: gitSpawn cwd is args.destination, so it must exist before spawn (fresh installs may lack the defaulted parent).
          await mkdir(args.destination, { recursive: true })
          claimedTarget = await claimCloneTarget(clonePath)
          // Why: spawn (not execFile) avoids the maxBuffer limit — clone progress on stderr can exceed Node's 1 MB default.
          // Why: --progress forces git to emit progress even when stderr isn't a TTY.
          try {
            // Why: use the parent destination as cwd so the runner detects a WSL path and routes through wsl.exe.
            // Why: '--' isolates the URL so a malicious URL can't be read as git flags (command injection).
            proc = await gitSpawnAfterWindowsEnvironmentReady(
              ['clone', '--progress', '--', args.url, clonePath],
              {
                cwd: args.destination,
                admissionTier: 'interactive',
                // Why: without this, an auth-needing clone pops Git Credential Manager's OAuth window on Windows, unclosable in a restricted env (issue #7652).
                env: promptGuardGitEnv(),
                signal: pendingController.signal,
                stdio: ['ignore', 'ignore', 'pipe']
              }
            )
          } catch (err) {
            await cleanupClaimedCloneTarget(clonePath, claimedTarget)
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`Clone failed: ${message}`)
          }
        } finally {
          pendingLocalCloneControllers.delete(pendingController)
        }
        await new Promise<void>((resolve, reject) => {
          const generation = nextCloneGeneration++
          latestCloneGenerationByPath.set(clonePathKey, generation)
          const metadata: ActiveCloneMetadata = {
            path: clonePath,
            pathKey: clonePathKey,
            claimedTarget,
            process: proc,
            abortRequested: false,
            generation,
            pendingAbortCleanup: null,
            resolvePendingAbortCleanup: null
          }
          cloneMetadataRef.current = metadata
          activeClone = metadata

          let stderrTail = ''
          let settled = false
          proc.stderr!.on('data', (chunk: Buffer) => {
            const text = chunk.toString()
            stderrTail = (stderrTail + text).slice(-4096)

            // Why: git progress lines use \r to overwrite in-place; parse fragments the same as SSH clone.
            emitCloneProgressFromText(mainWindow, text)
          })

          const finishClone = async (
            code: number | null,
            signal: NodeJS.Signals | null,
            err?: Error
          ) => {
            if (settled) {
              return
            }
            settled = true
            // Why: only null activeClone if it still points to this proc; abort-and-retry may have reassigned it, stranding the new clone.
            if (activeClone?.process === proc) {
              activeClone = null
            }

            const cloneSucceeded = !err && code === 0 && !signal
            if (!cloneSucceeded) {
              // Why: only the process that created this target may remove it, and only after git reports failure.
              await cleanupOwnedCloneTarget(metadata)
            }
            if (metadata.abortRequested && !cloneSucceeded) {
              settleCloneAbortCleanup(metadata)
            }
            if (latestCloneGenerationByPath.get(metadata.pathKey) === metadata.generation) {
              latestCloneGenerationByPath.delete(metadata.pathKey)
            }

            if (err) {
              reject(new Error(`Clone failed: ${err.message}`))
            } else if (signal === 'SIGTERM') {
              reject(new Error('Clone aborted'))
            } else if (code === 0) {
              resolve()
            } else {
              reject(
                new Error(`Clone failed: ${getGitCloneFailureMessage(stderrTail, { clonePath })}`)
              )
            }
          }

          proc.on('error', (err) => {
            void finishClone(null, null, err)
          })

          proc.on('close', (code, signal) => {
            void finishClone(code, signal)
          })
        })

        try {
          // Why: check after clone (path didn't exist before); reuse+upgrade a folder repo clone landed into instead of duplicating.
          const existing = findSaved()
          if (existing) {
            const conversion = await resolveClonedFolderConversion(store, existing)
            const current = findSaved()
            if (
              current &&
              conversion &&
              findExtraFolderWorkspaceIds(current, store.getAllWorktreeMeta()).length === 0 &&
              current.path === existing.path &&
              isFolderRepo(current) &&
              getRepoExecutionHostId(current) === getRepoExecutionHostId(existing)
            ) {
              const updated = store.updateRepo(current, {
                kind: 'git',
                ...conversion,
                projectHostSetupMethod: 'cloned'
              })
              if (updated) {
                await prepareLocalWorktreeRootForRepo(store, updated)
                invalidateAuthorizedRootsCache()
                notifyReposChanged(mainWindow)
                // Why: folder→git upgrade is a real new git repo provisioning event.
                emitRepoAdded('clone_url', false, true)
                return updated
              }
            }
            // Why: git re-created this project's folder, so its worktree root is gone with it and
            // the authorized-roots cache still holds the answers from before the folder came back.
            if (current) {
              return await finalizeReusedClone(current)
            }
          }

          const detected = await detectRepoIconAndUpstream({
            repoPath: clonePath,
            kind: 'git',
            executionHostId: LOCAL_EXECUTION_HOST_ID
          })
          // Icon discovery is async, so another registration can land after the check above.
          const raceWinner = findSaved()
          if (raceWinner) {
            return await finalizeReusedClone(raceWinner)
          }
          const repo: Repo = {
            id: randomUUID(),
            path: clonePath,
            displayName: getRepoName(clonePath),
            badgeColor: DEFAULT_REPO_BADGE_COLOR,
            ...detected,
            addedAt: Date.now(),
            kind: 'git',
            externalWorktreeVisibilityLegacy: false,
            projectHostSetupMethod: 'cloned'
          }

          store.addRepo(repo)
          reportNewGitRepository(scope.observer, repo)
          await prepareLocalWorktreeRootForRepo(store, repo)
          invalidateAuthorizedRootsCache()
          notifyReposChanged(mainWindow)
          emitRepoAdded('clone_url', false, true)
          return repo
        } finally {
          const metadata = cloneMetadataRef.current
          if (metadata?.abortRequested) {
            settleCloneAbortCleanup(metadata)
          }
        }
      })
      // Without an opt-in the channel keeps returning the bare row.
      return request.data ? { repo: clonedRepo, ...scope.singleFields() } : clonedRepo
    }
  )
}
