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
import { gitExecFileAsync } from '../../git/runner'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { invalidateAuthorizedRootsCache } from '../registered-worktree-roots-cache'
import { emitRepoAdded } from './repo-added-telemetry'
import { notifyReposChanged } from './repos-changed-notification'
import { addLocalRepoFromPath } from './local-repo-registration'
import { addRemoteRepoFromPath } from './remote-repo-registration'
import { createRemoteRepo } from './remote-repo-creation'

const GIT_AVAILABILITY_TIMEOUT_MS = 1500

async function isGitAvailable(): Promise<boolean> {
  try {
    await gitExecFileAsync(['--version'], {
      cwd: process.cwd(),
      timeout: GIT_AVAILABILITY_TIMEOUT_MS
    })
    return true
  } catch {
    return false
  }
}

/**
 * Where the "Create new project" Location field starts. Settings -> Workspace
 * Directory owns this once the user has actually set it, including a per-host
 * override for the local host, which is the only scope this handler answers for.
 *
 * Why the untouched default does not count: `workspaceDir` is never blank -- new
 * installs seed it with `~/orca/workspaces`. Treating that seeded value as a choice
 * would silently relocate every existing user's projects into the worktree root,
 * where each project would then host its own worktrees inside its working tree.
 */
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
  ipcMain.handle('repos:isGitAvailable', () => isGitAvailable())
  ipcMain.handle('repos:getDefaultCreateProjectParent', () => getDefaultCreateProjectParent(store))

  ipcMain.handle(
    'repos:add',
    async (
      _event,
      args: { path: string; kind?: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await addLocalRepoFromPath(store, args.path, args.kind)
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

  ipcMain.handle(
    'repos:addRemote',
    async (
      _event,
      args: {
        connectionId: string
        remotePath: string
        displayName?: string
        kind?: 'git' | 'folder'
      }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await addRemoteRepoFromPath(store, args)
      if ('error' in result) {
        return result
      }
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', result.alreadyExisted, result.repo.kind === 'git')
      return { repo: result.repo }
    }
  )

  ipcMain.handle(
    'repos:createRemote',
    async (
      _event,
      args: {
        connectionId: string
        parentPath: string
        name: string
        kind: 'git' | 'folder'
      }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const result = await createRemoteRepo(store, args)
      if ('error' in result) {
        return result
      }
      notifyReposChanged(mainWindow)
      return result
    }
  )

  // Create a repo/folder from scratch (orca#763); git repos need an empty initial commit so HEAD has a branch ref for worktrees.
  ipcMain.handle(
    'repos:create',
    async (
      _event,
      args: { parentPath: string; name: string; kind: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const name = args.name?.trim() ?? ''
      const parentPath = args.parentPath?.trim() ?? ''
      // Why: IPC input is untrusted — coerce to the narrow union so a bogus kind can't skip git init yet persist in the store.
      const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'

      if (!name) {
        return { error: 'Name cannot be empty' }
      }
      // Block slashes and ./.. so the name can't escape the chosen parent (guards direct IPC use).
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        return { error: 'Name cannot contain slashes or be "." / ".."' }
      }
      if (!parentPath) {
        return { error: 'Parent directory is required' }
      }
      // Why: block CWD-relative paths at the IPC boundary — keeps targetPath stable across process cwd changes.
      if (!isAbsolute(parentPath)) {
        return { error: 'Parent directory must be an absolute path' }
      }

      const targetPath = join(parentPath, name)

      // Dedup by path so a double-click on Create doesn't make two entries for one folder (first of three dedup checks).
      const existing = store.getRepos().find((r) => r.path === targetPath)
      if (existing) {
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: existing }
      }

      // Empty pre-existing dirs are allowed (e.g. made in Finder first); non-empty ones are rejected so we don't overwrite files.
      let createdDir = false
      let targetExists = false
      try {
        // Why: the default parent (~/orca/projects) may not exist on a fresh install; create only the parent before probing the target.
        await mkdir(parentPath, { recursive: true })
        await access(targetPath)
        targetExists = true
      } catch (err) {
        // Why: only ENOENT means the path is free; other codes are something mkdir can't fix, so surface a precise error.
        // Why: tests/non-Node errors lack a code, so treat an ENOENT-looking message as ENOENT to avoid over-rejecting.
        const code =
          err && typeof err === 'object' && 'code' in err
            ? (err as NodeJS.ErrnoException).code
            : undefined
        const looksLikeEnoent =
          code === 'ENOENT' ||
          (code === undefined && err instanceof Error && /ENOENT/.test(err.message))
        if (!looksLikeEnoent) {
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Cannot access target path: ${message}` }
        }
      }

      if (targetExists) {
        try {
          const entries = await readdir(targetPath)
          if (entries.length > 0) {
            return {
              error: `"${name}" already exists at this location and is not empty.`
            }
          }
        } catch (err) {
          // Why: access ok but readdir failed — path exists but isn't an inspectable dir (file or perms); return a distinct error.
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Failed to read directory: ${message}` }
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false })
          createdDir = true
        } catch (err) {
          // Why: EEXIST means a concurrent repos:create won the mkdir race; return its store entry instead of a confusing error.
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
          return { error: `Failed to create directory: ${message}` }
        }
      }

      if (repoKind === 'git') {
        // Why: track which git step ran so catch can attribute failure; the identity-hint regex only applies during commit.
        let step: 'init' | 'commit' = 'init'
        try {
          await gitExecFileAsync(['init'], { cwd: targetPath })
          step = 'commit'
          await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
            cwd: targetPath
          })
        } catch (err) {
          // Only rm the dir if we made it (pre-existing folders must survive retry); otherwise strip just the .git/ that git init created.
          if (createdDir) {
            await rm(targetPath, { recursive: true, force: true }).catch(() => {})
          } else if (step === 'commit') {
            await rm(join(targetPath, '.git'), { recursive: true, force: true }).catch(() => {})
          }
          const message = err instanceof Error ? err.message : String(err)
          if (
            step === 'commit' &&
            /Please tell me who you are|user\.name|user\.email/i.test(message)
          ) {
            return {
              error:
                'Git author identity is not configured. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
            }
          }
          const stepLabel =
            step === 'init'
              ? 'Failed to initialize git repository'
              : 'Failed to create initial commit'
          return { error: `${stepLabel}: ${message}` }
        }
      }

      // Why: ipcMain.handle doesn't serialize calls, so re-check dedup here to close the race between the first check and addRepo.
      const raceWinner = store.getRepos().find((r) => r.path === targetPath)
      if (raceWinner) {
        // Why: don't rm even if we made the dir — the race winner owns it; leaking an empty folder beats deleting a dir in use.
        emitRepoAdded('folder_picker', true, repoKind === 'git')
        return { repo: raceWinner }
      }

      const detected = await detectRepoIconAndUpstream({ repoPath: targetPath, kind: repoKind })
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
      // Why: repos:create git-inits when kind is 'git', so repoKind is the true git-vs-folder signal.
      emitRepoAdded('folder_picker', false, repoKind === 'git')
      return { repo }
    }
  )
}
