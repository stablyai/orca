import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { ChildProcess } from 'node:child_process'
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
import { resolveClonedFolderConversion } from '../../folder-repo-git-conversion'
import { findExtraFolderWorkspaceIds } from '../../folder-workspace-meta-presence'

type ActiveCloneMetadata = {
  path: string
  pathKey: string
  claimedTarget: ClaimedCloneTarget
  process: ChildProcess
  abortRequested: boolean
  generation: number
  pendingAbortCleanup: Promise<void> | null
  resolvePendingAbortCleanup: (() => void) | null
}

// Module scope preserves cancellation across macOS window recreation.
let activeClone: ActiveCloneMetadata | null = null
const pendingLocalCloneControllers = new Set<AbortController>()
let nextCloneGeneration = 1
const latestCloneGenerationByPath = new Map<string, number>()
const pendingAbortCleanupByPath = new Map<string, Promise<void>>()

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
  // An aborted clone must not delete a newer retry targeting the same path.
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

function markCloneAbortCleanupPending(metadata: ActiveCloneMetadata): void {
  if (metadata.resolvePendingAbortCleanup) {
    return
  }
  metadata.pendingAbortCleanup = new Promise<void>((resolve) => {
    metadata.resolvePendingAbortCleanup = resolve
  })
  pendingAbortCleanupByPath.set(metadata.pathKey, metadata.pendingAbortCleanup)
}

function settleCloneAbortCleanup(metadata: ActiveCloneMetadata): void {
  if (pendingAbortCleanupByPath.get(metadata.pathKey) === metadata.pendingAbortCleanup) {
    pendingAbortCleanupByPath.delete(metadata.pathKey)
  }
  metadata.resolvePendingAbortCleanup?.()
  metadata.pendingAbortCleanup = null
  metadata.resolvePendingAbortCleanup = null
}

export function registerRepoCloneHandlers(mainWindow: BrowserWindow, store: Store): void {
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
    async (_event, args: { url: string; destination: string }): Promise<Repo> => {
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
      return runWithClonePathLock(clonePathKey, async () => {
        await pendingAbortCleanupByPath.get(clonePathKey)
        const cloneMetadataRef: { current: ActiveCloneMetadata | null } = { current: null }
        let claimedTarget: ClaimedCloneTarget
        let proc: Awaited<ReturnType<typeof gitSpawnAfterWindowsEnvironmentReady>>
        // Register before saved-project reads so Cancel can abort those Git calls too.
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
            emitRepoAdded('clone_url', true, true)
            return reused
          }
          // Fresh installs may lack the destination used as the clone process cwd.
          await mkdir(args.destination, { recursive: true })
          claimedTarget = await claimCloneTarget(clonePath)
          // Stream progress to avoid execFile buffer limits; --progress also works without a TTY.
          try {
            // Destination cwd enables WSL routing; '--' prevents URL content from becoming Git flags.
            proc = await gitSpawnAfterWindowsEnvironmentReady(
              ['clone', '--progress', '--', args.url, clonePath],
              {
                cwd: args.destination,
                admissionTier: 'interactive',
                // Suppress Windows Git Credential Manager OAuth windows during noninteractive cloning (#7652).
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

            // Git progress uses carriage-return fragments, matching the SSH clone parser.
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
            // Abort-and-retry may already have replaced the active process.
            if (activeClone?.process === proc) {
              activeClone = null
            }

            const cloneSucceeded = !err && code === 0 && !signal
            if (!cloneSucceeded) {
              // Failed-clone cleanup belongs only to the process that created this target.
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
          // Clone may land in an existing folder project; upgrade it instead of duplicating registration.
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
                // Folder-to-Git conversion counts as new Git provisioning.
                emitRepoAdded('clone_url', false, true)
                return updated
              }
            }
            // Recreating the folder loses its worktree root and invalidates cached authorization.
            if (current) {
              await prepareLocalWorktreeRootForRepo(store, current)
              invalidateAuthorizedRootsCache()
              notifyReposChanged(mainWindow)
              emitRepoAdded('clone_url', true, true)
              return current
            }
          }

          const detected = await detectRepoIconAndUpstream({
            repoPath: clonePath,
            kind: 'git',
            executionHostId: LOCAL_EXECUTION_HOST_ID
          })
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
    }
  )
}
