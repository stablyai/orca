import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { DEFAULT_REPO_BADGE_COLOR, getDefaultWorkspaceDir } from '../../../shared/constants'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { getEffectiveHostSetting } from '../../../shared/host-setting-overrides'
import { probeGitAvailability } from '../../git/git-availability'
import { gitExecFileAsync } from '../../git/runner'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { repoCreateFailure, type RepoCreateFailure } from '../../../shared/repo-create-failure-copy'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'
import { addLocalRepoFromPath } from './local-repo-registration'

const GIT_AVAILABILITY_TIMEOUT_MS = 1500

// Only ENOENT proves Git absent; rejecting other failures preserves the renderer's unknown state.
export async function probeLocalGitAvailability(): Promise<boolean> {
  return probeGitAvailability(gitExecFileAsync, {
    cwd: process.cwd(),
    timeout: GIT_AVAILABILITY_TIMEOUT_MS
  })
}

/** Ignore seeded workspaceDir: treating it as user intent nests projects inside the worktree root. */
function getDefaultCreateProjectParent(store: Store): string {
  const home = homedir()
  const settings = store.getSettings()
  const configured = getEffectiveHostSetting(
    settings,
    LOCAL_EXECUTION_HOST_ID,
    'defaultWorktreeLocation',
    settings.workspaceDir ?? ''
  ).trim()
  const isUntouchedDefault =
    normalizeRuntimePathForComparison(configured) ===
    normalizeRuntimePathForComparison(getDefaultWorkspaceDir(home))
  if (configured && !isUntouchedDefault) {
    return configured
  }
  return join(home, 'orca', 'projects')
}

export function registerRepoCreationHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle('repos:isGitAvailable', () => probeLocalGitAvailability())
  ipcMain.handle('repos:getDefaultCreateProjectParent', () => getDefaultCreateProjectParent(store))

  ipcMain.handle(
    'repos:add',
    async (
      _event,
      args: { path: string; kind?: 'git' | 'folder'; displayName?: string }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await addLocalRepoFromPath(store, args.path, args.kind, args.displayName)
      if ('error' in result) {
        return result
      }
      if (result.alreadyExisted) {
        await prepareLocalWorktreeRootForRepo(store, result.repo)
      }
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted, result.repo.kind === 'git')
      return { repo: result.repo }
    }
  )

  // An initial commit gives Git projects the HEAD ref needed for worktrees.
  ipcMain.handle(
    'repos:create',
    async (
      _event,
      args: { parentPath: string; name: string; kind: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | RepoCreateFailure> => {
      const name = args.name?.trim() ?? ''
      const parentPath = args.parentPath?.trim() ?? ''
      // Untrusted IPC kinds must not skip Git initialization yet persist as Git projects.
      const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'

      if (!name) {
        return repoCreateFailure('nameEmpty')
      }
      // Reject traversal even for direct IPC callers.
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        return repoCreateFailure('nameInvalid')
      }
      if (!parentPath) {
        return repoCreateFailure('parentRequired')
      }
      // Absolute parents keep target paths stable across process cwd changes.
      if (!isAbsolute(parentPath)) {
        return repoCreateFailure('parentNotAbsolute')
      }

      const targetPath = join(parentPath, name)

      // Repeated Create requests must share one registration.
      const existing = store.getRepos().find((r) => r.path === targetPath)
      if (existing) {
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: existing }
      }

      // Accept empty preexisting folders without overwriting user files.
      let createdDir = false
      let targetExists = false
      try {
        // Fresh installs may lack the default project parent.
        await mkdir(parentPath, { recursive: true })
        await access(targetPath)
        targetExists = true
      } catch (err) {
        // Only ENOENT proves the target is free; uncoded errors retain message-based compatibility.
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as NodeJS.ErrnoException).code
            : undefined
        const looksLikeEnoent =
          code === 'ENOENT' ||
          (code === undefined && err instanceof Error && /ENOENT/.test(err.message))
        if (!looksLikeEnoent) {
          const message = err instanceof Error ? err.message : String(err)
          return repoCreateFailure('targetInaccessible', { detail: message })
        }
      }

      if (targetExists) {
        try {
          const entries = await readdir(targetPath)
          if (entries.length > 0) {
            return repoCreateFailure('targetNotEmpty', { name })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return repoCreateFailure('readDirectoryFailed', { detail: message })
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false })
          createdDir = true
        } catch (err) {
          // A concurrent create may win mkdir; reuse its registration on EEXIST.
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as NodeJS.ErrnoException).code
              : undefined
          const isEexist = code === 'EEXIST' || (err instanceof Error && /EEXIST/.test(err.message))
          if (isEexist) {
            const raceWinner = store.getRepos().find((r) => r.path === targetPath)
            if (raceWinner) {
              return { repo: raceWinner }
            }
          }
          const message = err instanceof Error ? err.message : String(err)
          return repoCreateFailure('createDirectoryFailed', {
            detail: message
          })
        }
      }

      if (repoKind === 'git') {
        // The failing Git step controls attribution and commit-only identity hints.
        let step: 'init' | 'commit' = 'init'
        try {
          await gitExecFileAsync(['init'], { cwd: targetPath })
          step = 'commit'
          await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
            cwd: targetPath
          })
        } catch (err) {
          // Rollback may remove only what this request created; preserve preexisting folders.
          if (createdDir) {
            await rm(targetPath, { recursive: true, force: true }).catch(() => {})
          } else if (step === 'commit') {
            await rm(join(targetPath, '.git'), {
              recursive: true,
              force: true
            }).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          if (
            step === 'commit' &&
            /Please tell me who you are|user\.name|user\.email/i.test(message)
          ) {
            return repoCreateFailure('gitIdentityMissing')
          }
          return repoCreateFailure(step === 'init' ? 'gitInitFailed' : 'initialCommitFailed', {
            detail: message
          })
        }
      }

      // IPC calls interleave while awaiting filesystem and Git work; recheck before registration.
      const raceWinner = store.getRepos().find((r) => r.path === targetPath)
      if (raceWinner) {
        // A concurrent winner owns the directory even if this request created it.
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: raceWinner }
      }

      const detected = await detectRepoIconAndUpstream({
        repoPath: targetPath,
        kind: repoKind,
        executionHostId: LOCAL_EXECUTION_HOST_ID
      })
      const repo: Repo = {
        id: randomUUID(),
        path: targetPath,
        displayName: name,
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        ...detected,
        addedAt: Date.now(),
        kind: repoKind,
        ...(repoKind === 'git'
          ? {
              externalWorktreeVisibilityLegacy: false,
              projectHostSetupMethod: 'imported-existing-folder' as const
            }
          : {})
      }

      store.addRepo(repo)
      await prepareLocalWorktreeRootForRepo(store, repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', false, repoKind === 'git')
      return { repo }
    }
  )
}
