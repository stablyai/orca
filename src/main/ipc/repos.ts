/* eslint-disable max-lines -- Why: repo IPC is intentionally centralized so SSH
routing, clone lifecycle, and store persistence stay behind a single audited
boundary. Splitting by line count would scatter tightly coupled repo behavior. */
import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type { Repo, BaseRefDefaultResult, SparsePreset } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { REPO_COLORS } from '../../shared/constants'
import { invalidateAuthorizedRootsCache } from './filesystem-auth'
import type { ChildProcess } from 'child_process'
import { access, mkdir, readdir, rm } from 'fs/promises'
import { gitExecFileAsync, gitSpawn } from '../git/runner'
import { basename, isAbsolute, join } from 'path'
import {
  isGitRepo,
  getGitUsername,
  getRepoName,
  getBaseRefDefault,
  getRemoteCount,
  normalizeRefSearchQuery,
  parseAndFilterSearchRefs,
  parseRemoteCount,
  resolveDefaultBaseRefViaExec,
  buildSearchBaseRefsArgv,
  searchBaseRefs
} from '../git/repo'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getActiveMultiplexer } from './ssh'
import { normalizeSparseDirectories } from './sparse-checkout-directories'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import type { RepoMethod } from '../../shared/telemetry-events'

// Why: `method` answers "which entry point did the user take?", not "what did
// they add?" — so the IPC the renderer invoked IS the method. We never send
// the path, URL, or display name. `repos:create` collapses into
// `folder_picker` because the user's entry was the folder picker, even
// though main also `git init`s. `drag_drop` is reserved for a future call
// site; no current renderer surface produces it.
function emitRepoAdded(method: RepoMethod, alreadyExisted: boolean): void {
  // Why: re-adding an existing repo (matched by path inside the handler)
  // is not a new activation event. Suppressing the duplicate keeps the
  // funnel honest and avoids inflating `repo_added` for users who
  // re-pick the same folder.
  if (alreadyExisted) {
    return
  }
  // Why: cohort must read AFTER `store.addRepo()` lands so the just-added
  // repo is counted — every call site below already emits post-addRepo, so
  // `getCohortAtEmit()` here returns the user's Nth `repo_added` as `N`.
  // See docs/onboarding-funnel-cohort-addendum.md §Read-vs-write ordering.
  track('repo_added', { method, ...getCohortAtEmit() })
}

// Why: module-scoped so the abort handle survives window re-creation on macOS.
// registerRepoHandlers is called again when a new BrowserWindow is created,
// and a function-scoped variable would lose the reference to an in-flight clone.
let activeCloneProc: ChildProcess | null = null
let activeClonePath: string | null = null

export function registerRepoHandlers(mainWindow: BrowserWindow, store: Store): void {
  // Remove any previously registered handlers so we can re-register them
  // (e.g. when macOS re-activates the app and creates a new window).
  ipcMain.removeHandler('repos:list')
  ipcMain.removeHandler('repos:add')
  ipcMain.removeHandler('repos:remove')
  ipcMain.removeHandler('repos:update')
  ipcMain.removeHandler('repos:pickFolder')
  ipcMain.removeHandler('repos:pickDirectory')
  ipcMain.removeHandler('repos:clone')
  ipcMain.removeHandler('repos:cloneAbort')
  ipcMain.removeHandler('repos:getGitUsername')
  ipcMain.removeHandler('repos:getBaseRefDefault')
  ipcMain.removeHandler('repos:searchBaseRefs')
  ipcMain.removeHandler('repos:addRemote')
  ipcMain.removeHandler('repos:create')
  ipcMain.removeHandler('sparsePresets:list')
  ipcMain.removeHandler('sparsePresets:save')
  ipcMain.removeHandler('sparsePresets:remove')

  ipcMain.handle('repos:list', () => {
    return store.getRepos()
  })

  ipcMain.handle(
    'repos:add',
    async (
      _event,
      args: { path: string; kind?: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const repoKind = args.kind === 'folder' ? 'folder' : 'git'
      if (repoKind === 'git' && !isGitRepo(args.path)) {
        return { error: `Not a valid git repository: ${args.path}` }
      }

      // Check if already added
      const existing = store.getRepos().find((r) => r.path === args.path)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      const repo: Repo = {
        id: randomUUID(),
        path: args.path,
        displayName: getRepoName(args.path),
        badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
        addedAt: Date.now(),
        kind: repoKind
      }

      store.addRepo(repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', false)
      return { repo }
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
      const gitProvider = getSshGitProvider(args.connectionId)
      if (!gitProvider) {
        return { error: `SSH connection "${args.connectionId}" not found or not connected` }
      }

      let repoKind: 'git' | 'folder' = args.kind ?? 'git'
      let resolvedPath = args.remotePath

      // Why: `~` is a shell expansion that Node's fs APIs don't understand.
      // Resolve tilde paths to absolute paths via the relay before storing,
      // so all downstream fs operations (readDir, stat, etc.) work correctly.
      if (resolvedPath === '~' || resolvedPath === '~/' || resolvedPath.startsWith('~/')) {
        const mux = getActiveMultiplexer(args.connectionId)
        if (mux) {
          try {
            const result = (await mux.request('session.resolveHome', {
              path: resolvedPath
            })) as { resolvedPath: string }
            resolvedPath = result.resolvedPath
          } catch {
            // Relay may not support resolveHome yet — fall through to raw path
          }
        }
      }

      // Why: check for duplicates after tilde resolution so that adding `~/`
      // when `/home/ubuntu` is already stored correctly detects the duplicate.
      const existing = store
        .getRepos()
        .find((r) => r.connectionId === args.connectionId && r.path === resolvedPath)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      const pathSegments = resolvedPath.replace(/\/+$/, '').split('/')
      let folderName = pathSegments.at(-1) || resolvedPath

      if (args.kind !== 'folder') {
        // Why: when kind is not explicitly 'folder', verify the remote path is
        // a git repo. Return an error on failure so the renderer can show the "Open as
        // Folder" confirmation dialog — matching the local add-repo behavior
        // where non-git directories require explicit user consent.
        try {
          const check = await gitProvider.isGitRepoAsync(resolvedPath)
          if (check.isRepo) {
            repoKind = 'git'
            if (check.rootPath) {
              resolvedPath = check.rootPath
            }
          } else {
            return { error: `Not a valid git repository: ${args.remotePath}` }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('Not a valid git repository')) {
            return { error: err.message }
          }
          return { error: `Not a valid git repository: ${args.remotePath}` }
        }
      }

      // When folderName is the home directory basename (e.g. 'ubuntu'),
      // use SSH target label for a more descriptive name
      let displayName = args.displayName || folderName
      if (!args.displayName && (args.remotePath === '~' || args.remotePath === '~/')) {
        const sshTarget = store.getSshTarget(args.connectionId)
        if (sshTarget) {
          displayName = sshTarget.label
        }
      }

      const repo: Repo = {
        id: randomUUID(),
        path: resolvedPath,
        displayName,
        badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
        addedAt: Date.now(),
        kind: repoKind,
        connectionId: args.connectionId
      }

      store.addRepo(repo)
      notifyReposChanged(mainWindow)

      // Why: register the workspace root with the relay so mutating FS operations
      // are scoped to this repo's path. Without this, the relay's path ACL would
      // reject writes to the workspace after the first root is registered.
      const mux = getActiveMultiplexer(args.connectionId)
      if (mux) {
        mux.notify('session.registerRoot', { rootPath: resolvedPath })
      }

      emitRepoAdded('folder_picker', false)
      return { repo }
    }
  )

  // Creates a new repo or folder from scratch (orca#763). An empty initial
  // commit is required for git repos so HEAD has a branch ref — Orca's
  // worktree features all need one.
  ipcMain.handle(
    'repos:create',
    async (
      _event,
      args: { parentPath: string; name: string; kind: 'git' | 'folder' }
    ): Promise<{ repo: Repo } | { error: string }> => {
      const name = args.name?.trim() ?? ''
      const parentPath = args.parentPath?.trim() ?? ''
      // Why: IPC input is untrusted — coerce to the narrow union so a bogus
      // string (e.g. "x") can't skip git init yet persist as kind: "x" in the
      // store. Mirrors the coercion in repos:add above.
      const repoKind: 'git' | 'folder' = args.kind === 'folder' ? 'folder' : 'git'

      if (!name) {
        return { error: 'Name cannot be empty' }
      }
      // Block slashes and ./.. so the name can't escape the chosen parent.
      // The UI already disables submit in these cases; this guards direct IPC use.
      if (/[\\/]/.test(name) || name === '.' || name === '..') {
        return { error: 'Name cannot contain slashes or be "." / ".."' }
      }
      if (!parentPath) {
        return { error: 'Parent directory is required' }
      }
      // Why: blocks CWD-relative paths from slipping through the IPC boundary;
      // the UI uses pickDirectory which returns absolute paths, this guards
      // direct IPC use (and keeps targetPath stable across process cwd changes).
      if (!isAbsolute(parentPath)) {
        return { error: 'Parent directory must be an absolute path' }
      }

      const targetPath = join(parentPath, name)

      // Dedup by path (same as repos:add) so a double-click on Create doesn't
      // produce two sidebar entries pointing at the same folder. This is the
      // first of three dedup checks; see the pre-addRepo check below for why
      // the race matters even after this one passes.
      const existing = store.getRepos().find((r) => r.path === targetPath)
      if (existing) {
        emitRepoAdded('folder_picker', true)
        return { repo: existing }
      }

      // Empty pre-existing directories are allowed (e.g. one the user made in
      // Finder first). Non-empty ones are rejected so we don't overwrite files.
      let createdDir = false
      let targetExists = false
      try {
        await access(targetPath)
        targetExists = true
      } catch (err) {
        // Why: only ENOENT means "the path is free to use". Other codes
        // (EACCES, ENOTDIR, EPERM, ELOOP, ...) mean something is in the way
        // that mkdir can't fix — surface a precise error instead of falling
        // through to mkdir and returning a misleading "Failed to create
        // directory" message.
        //
        // Why the message fallback: fs.promises.access always attaches a
        // NodeJS.ErrnoException code in production, but plain Error objects
        // thrown in tests / non-Node contexts won't — treat a message that
        // reads like ENOENT as one so we don't over-reject.
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
          // Why: access succeeded but readdir failed — the path exists but we
          // can't inspect it (e.g. it's a file, not a directory; or perms).
          // mkdir would definitely fail here too, so return a distinct error.
          const message = err instanceof Error ? err.message : String(err)
          return { error: `Failed to read directory: ${message}` }
        }
      } else {
        try {
          await mkdir(targetPath, { recursive: false })
          createdDir = true
        } catch (err) {
          // Why: EEXIST here means another concurrent repos:create for the
          // same path won the mkdir race. If they already added the repo to
          // the store, return that entry instead of a confusing error. This
          // is the second dedup check; see the pre-addRepo check below for
          // the full race explanation.
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
        // Why: track which git step is running so the catch can attribute the
        // failure correctly. The identity-hint regex is only meaningful during
        // commit — git init itself never produces "Please tell me who you are".
        let step: 'init' | 'commit' = 'init'
        try {
          await gitExecFileAsync(['init'], { cwd: targetPath })
          step = 'commit'
          await gitExecFileAsync(['commit', '--allow-empty', '-m', 'Initial commit'], {
            cwd: targetPath
          })
        } catch (err) {
          // Only remove the directory if we made it. A pre-existing folder the
          // user picked must survive so they can retry after fixing git config.
          // Why: if we didn't make the directory but `git init` created `.git/`
          // inside it, strip just `.git/` so the user's folder looks the way
          // they left it. Retrying works either way, but leaving a half-init'd
          // repo behind is confusing if they choose to skip the retry.
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

      // Why: ipcMain.handle doesn't serialize concurrent calls; re-running the
      // dedup lookup here closes the window between the first check and
      // addRepo. A second repos:create for the same path that raced past the
      // initial dedup now returns the entry the first call persisted.
      const raceWinner = store.getRepos().find((r) => r.path === targetPath)
      if (raceWinner) {
        // Why: do NOT rm even if this invocation created the directory — the
        // other invocation is using it. Leaking a freshly-made empty folder on
        // a rare race is strictly safer than deleting a directory the winning
        // call (and the user) now owns.
        emitRepoAdded('folder_picker', true)
        return { repo: raceWinner }
      }

      const repo: Repo = {
        id: randomUUID(),
        path: targetPath,
        displayName: name,
        badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
        addedAt: Date.now(),
        kind: repoKind
      }

      store.addRepo(repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('folder_picker', false)
      return { repo }
    }
  )

  ipcMain.handle('repos:remove', async (_event, args: { repoId: string }) => {
    store.removeRepo(args.repoId)
    invalidateAuthorizedRootsCache()
    notifyReposChanged(mainWindow)
  })

  ipcMain.handle(
    'repos:update',
    (
      _event,
      args: {
        repoId: string
        updates: Partial<
          Pick<
            Repo,
            | 'displayName'
            | 'badgeColor'
            | 'hookSettings'
            | 'worktreeBaseRef'
            | 'kind'
            | 'symlinkPaths'
            | 'issueSourcePreference'
          >
        >
      }
    ) => {
      // Why: validate the persisted preference string at the IPC boundary
      // — the TypeScript signature is erased at runtime, and a preload
      // version skew or renderer bug could otherwise persist a garbage
      // string that silently collapses to 'auto' in `resolveIssueSource`
      // (see gh-utils.ts#resolveIssueSource). Strip rather than throw so
      // other valid fields in the same call still persist.
      const updates = { ...args.updates }
      if (
        'issueSourcePreference' in updates &&
        updates.issueSourcePreference !== undefined &&
        updates.issueSourcePreference !== 'upstream' &&
        updates.issueSourcePreference !== 'origin' &&
        updates.issueSourcePreference !== 'auto'
      ) {
        delete updates.issueSourcePreference
      }
      // Why: `symlinkPaths` is consumed by `createWorktreeSymlinks` which
      // calls `.trim()` on each entry. A renderer bug or preload-version skew
      // that persists a non-`string[]` value (e.g. `[42, null]`, a bare
      // string) would throw inside the worktree-create path with no UI
      // signal. Strip invalid shapes at the boundary the same way
      // `issueSourcePreference` is validated above.
      if ('symlinkPaths' in updates && updates.symlinkPaths !== undefined) {
        const v = updates.symlinkPaths as unknown
        if (!Array.isArray(v) || !v.every((e) => typeof e === 'string')) {
          delete updates.symlinkPaths
        }
      }
      const updated = store.updateRepo(args.repoId, updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

  // ── Sparse presets ─────────────────────────────────────────────
  // Why: presets are repo-scoped reusable directory lists used by the
  // new-workspace composer. Persisted via Store and broadcast back to the
  // renderer so any open composer reflects new/edited/deleted presets
  // immediately.

  ipcMain.handle('sparsePresets:list', (_event, args: { repoId: string }) => {
    return store.getSparsePresets(args.repoId)
  })

  ipcMain.handle(
    'sparsePresets:save',
    (
      _event,
      args: { repoId: string; id?: string; name: string; directories: string[] }
    ): SparsePreset => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo "${args.repoId}" not found`)
      }
      const name = normalizeSparsePresetName(args.name)
      const directories = normalizeSparsePresetDirectories(args.directories)
      const now = Date.now()
      const existing = args.id
        ? store.getSparsePresets(args.repoId).find((preset) => preset.id === args.id)
        : undefined
      const preset: SparsePreset = {
        id: existing?.id ?? randomUUID(),
        repoId: args.repoId,
        name,
        directories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      const saved = store.saveSparsePreset(preset)
      notifySparsePresetsChanged(mainWindow, args.repoId)
      return saved
    }
  )

  ipcMain.handle('sparsePresets:remove', (_event, args: { repoId: string; presetId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo) {
      throw new Error(`Repo "${args.repoId}" not found`)
    }
    store.removeSparsePreset(args.repoId, args.presetId)
    notifySparsePresetsChanged(mainWindow, args.repoId)
  })

  ipcMain.handle('repos:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: pickDirectory is a generic "choose a folder" picker, separate from
  // pickFolder which is specifically the "add project" flow. Clone needs a
  // destination directory that may not be a git repo yet.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('repos:cloneAbort', async () => {
    if (activeCloneProc) {
      const pathToClean = activeClonePath
      activeCloneProc.kill()
      activeCloneProc = null
      activeClonePath = null
      // Why: git clone creates the target directory before it finishes.
      // Without cleanup, retrying the same URL/destination fails with
      // "destination path already exists and is not an empty directory".
      if (pathToClean) {
        await rm(pathToClean, { recursive: true, force: true }).catch(() => {
          // Best-effort cleanup — don't fail the abort if removal fails
        })
      }
    }
  })

  ipcMain.handle(
    'repos:clone',
    async (_event, args: { url: string; destination: string }): Promise<Repo> => {
      // Why: the user picks a parent directory (e.g. ~/projects) and we derive
      // the repo folder name from the URL (e.g. "orca" from .../orca.git).
      // This matches the default git clone behavior where the last path segment
      // of the URL becomes the directory name.
      const repoName = basename(args.url.replace(/\.git\/?$/, ''))
      if (!repoName) {
        throw new Error('Could not determine repository name from URL')
      }
      const clonePath = join(args.destination, repoName)

      // Why: use spawn instead of execFile so there is no maxBuffer limit.
      // git clone writes progress to stderr which can exceed Node's default
      // 1 MB buffer on large or submodule-heavy repos. We only keep the tail
      // of stderr for error reporting and discard stdout entirely.
      // Why: use --progress to force git to emit progress even when stderr
      // is not a TTY. Without it, git suppresses progress output when piped.
      await new Promise<void>((resolve, reject) => {
        // Why: clone destination may be a WSL path (e.g. user picks a WSL
        // directory). Use the parent destination as the cwd so the runner
        // detects WSL and routes through wsl.exe.
        // Why: use the '--' separator to isolate the URL argument and prevent
        // malicious URLs from being interpreted as git flags (command injection).
        const proc = gitSpawn(['clone', '--progress', '--', args.url, clonePath], {
          cwd: args.destination,
          stdio: ['ignore', 'ignore', 'pipe']
        })
        activeCloneProc = proc
        activeClonePath = clonePath

        let stderrTail = ''
        proc.stderr!.on('data', (chunk: Buffer) => {
          const text = chunk.toString()
          stderrTail = (stderrTail + text).slice(-4096)

          // Why: git progress lines use \r to overwrite in-place. Split on
          // both \r and \n to find the latest progress fragment, then extract
          // the phase name and percentage for the renderer.
          const lines = text.split(/[\r\n]+/)
          for (const line of lines) {
            const match = line.match(/^([\w\s]+):\s+(\d+)%/)
            if (match && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('repos:clone-progress', {
                phase: match[1].trim(),
                percent: parseInt(match[2], 10)
              })
            }
          }
        })

        proc.on('error', (err) => reject(new Error(`Clone failed: ${err.message}`)))

        proc.on('close', (code, signal) => {
          // Why: only clear the ref if it still points to this process.
          // A quick abort-and-retry can reassign activeCloneProc to a new
          // spawn before this handler fires, and nulling it would make the
          // new clone unabortable.
          if (activeCloneProc === proc) {
            activeCloneProc = null
            activeClonePath = null
          }
          if (signal === 'SIGTERM') {
            reject(new Error('Clone aborted'))
          } else if (code === 0) {
            resolve()
          } else {
            const lastLine = stderrTail.trim().split('\n').pop() ?? 'unknown error'
            reject(new Error(`Clone failed: ${lastLine}`))
          }
        })
      })

      // Why: check after clone (not before) because the path didn't exist
      // before cloning. But if the user somehow had a folder repo at this path
      // that git clone succeeded into (empty dir), reuse that entry and upgrade
      // its kind to 'git' instead of creating a duplicate.
      const existing = store.getRepos().find((r) => r.path === clonePath)
      if (existing) {
        if (isFolderRepo(existing)) {
          const updated = store.updateRepo(existing.id, { kind: 'git' })
          if (updated) {
            notifyReposChanged(mainWindow)
            // Why: folder→git upgrade is a real new git repo provisioning event.
            emitRepoAdded('clone_url', false)
            return updated
          }
        }
        emitRepoAdded('clone_url', true)
        return existing
      }

      const repo: Repo = {
        id: randomUUID(),
        path: clonePath,
        displayName: getRepoName(clonePath),
        badgeColor: REPO_COLORS[store.getRepos().length % REPO_COLORS.length],
        addedAt: Date.now(),
        kind: 'git'
      }

      store.addRepo(repo)
      invalidateAuthorizedRootsCache()
      notifyReposChanged(mainWindow)
      emitRepoAdded('clone_url', false)
      return repo
    }
  )

  ipcMain.handle('repos:getGitUsername', async (_event, args: { repoId: string }) => {
    const repo = store.getRepo(args.repoId)
    if (!repo || isFolderRepo(repo)) {
      return ''
    }
    // Why: remote repos have their git config on the remote host, so we
    // must route through the relay's git.exec to read user.name.
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return ''
      }
      try {
        const result = await provider.exec(['config', 'user.name'], repo.path)
        return result.stdout.trim()
      } catch {
        return ''
      }
    }
    return getGitUsername(repo.path)
  })

  ipcMain.handle(
    'repos:getBaseRefDefault',
    async (_event, args: { repoId: string }): Promise<BaseRefDefaultResult> => {
      const repo = store.getRepo(args.repoId)
      if (!repo || isFolderRepo(repo)) {
        // Why: folder-mode repos have no git state to resolve a base ref from.
        // Return null + 0 so the renderer can decline to use a fabricated default
        // and suppress the multi-remote hint.
        return { defaultBaseRef: null, remoteCount: 0 }
      }
      // Why: remote repos need the relay to resolve symbolic-ref on the
      // remote host where the git data lives.
      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          return { defaultBaseRef: null, remoteCount: 0 }
        }
        // Why: run default-ref resolution and remote-count concurrently to
        // match the local path's latency characteristics (see Promise.all
        // below). The two lookups are independent — neither depends on the
        // other's result — so serializing them only adds SSH round-trip
        // latency on slow relays.
        //
        // Why: delegate to the shared resolveDefaultBaseRefViaExec so SSH and
        // local repos return identical defaults for equivalent states. We
        // log in the exec callback for the symbolic-ref call to preserve the
        // SSH-specific transport-failure diagnostic (connection drops,
        // permission issues) that the shared helper otherwise swallows
        // together with the expected "origin/HEAD unset" non-zero exit.
        const resolveDefault = async (): Promise<string | null> => {
          return resolveDefaultBaseRefViaExec(async (argv) => {
            try {
              return await provider.exec(argv, repo.path)
            } catch (err) {
              if (argv[0] === 'symbolic-ref') {
                console.warn('[repos:getBaseRefDefault] SSH symbolic-ref failed', {
                  path: repo.path,
                  err
                })
              }
              throw err
            }
          })
        }

        const resolveRemoteCount = async (): Promise<number> => {
          try {
            const remotesResult = await provider.exec(['remote'], repo.path)
            return parseRemoteCount(remotesResult.stdout)
          } catch (err) {
            // Why: fall back to 0 (the "unknown / do not render the multi-remote
            // hint" sentinel). Log so diagnostic signal isn't lost.
            console.warn('[repos:getBaseRefDefault] SSH git remote count failed', {
              path: repo.path,
              err
            })
            return 0
          }
        }

        const [defaultBaseRef, remoteCount] = await Promise.all([
          resolveDefault(),
          resolveRemoteCount()
        ])
        return { defaultBaseRef, remoteCount }
      }
      // Why: compute default and remote count independently. A failure
      // counting remotes must not break default detection. Run in parallel
      // since the two lookups don't depend on each other.
      const [defaultBaseRef, remoteCount] = await Promise.all([
        getBaseRefDefault(repo.path),
        getRemoteCount(repo.path)
      ])
      return { defaultBaseRef, remoteCount }
    }
  )

  ipcMain.handle(
    'repos:searchBaseRefs',
    async (_event, args: { repoId: string; query: string; limit?: number }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo || isFolderRepo(repo)) {
        return []
      }
      const limit = args.limit ?? 25
      // Why: remote repos need the relay to list branches on the remote host.
      if (repo.connectionId) {
        const provider = getSshGitProvider(repo.connectionId)
        if (!provider) {
          return []
        }
        // Why: mirror the local path's sanitization (normalizeRefSearchQuery
        // in ../git/repo.ts) — strip glob metacharacters to prevent glob
        // injection via the SSH branch, and short-circuit empty queries so
        // we don't leak every ref. Without this the SSH path diverges from
        // the local path's behavior.
        const normalizedQuery = normalizeRefSearchQuery(args.query)
        if (!normalizedQuery) {
          return []
        }
        try {
          // Why: argv (including the two-remote-glob rationale) lives in
          // buildSearchBaseRefsArgv so the SSH and local paths cannot drift.
          const result = await provider.exec(buildSearchBaseRefsArgv(normalizedQuery), repo.path)
          // Why: delegate the NUL-parse + HEAD filter + dedup + limit pipeline
          // to the shared helper so the SSH and local paths cannot diverge.
          // See parseAndFilterSearchRefs in ../git/repo.ts for the dedup +
          // HEAD-filter rationale.
          return parseAndFilterSearchRefs(result.stdout, limit)
        } catch (err) {
          console.warn('[repos:searchBaseRefs] SSH for-each-ref failed', {
            path: repo.path,
            err
          })
          return []
        }
      }
      return searchBaseRefs(repo.path, args.query, limit)
    }
  )
}

function notifyReposChanged(mainWindow: BrowserWindow): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('repos:changed')
  }
}

function notifySparsePresetsChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sparsePresets:changed', { repoId })
  }
}

function normalizeSparsePresetName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  if (trimmed.length > 80) {
    throw new Error('Preset name is too long.')
  }
  return trimmed
}

function normalizeSparsePresetDirectories(directories: string[]): string[] {
  let normalized: string[]
  try {
    normalized = normalizeSparseDirectories(directories)
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === 'Sparse checkout directories must be repo-relative paths.'
    ) {
      throw new Error('Preset directories must be repo-relative paths.')
    }
    throw err
  }
  if (normalized.length === 0) {
    throw new Error('Preset must have at least one directory.')
  }
  return normalized
}
