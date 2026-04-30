/* eslint-disable max-lines -- Why: repo IPC is intentionally centralized so SSH
routing, clone lifecycle, and store persistence stay behind a single audited
boundary. Splitting by line count would scatter tightly coupled repo behavior. */
import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import type { Store } from '../persistence'
import type { Repo, BaseRefDefaultResult } from '../../shared/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { REPO_COLORS } from '../../shared/constants'
import { rebuildAuthorizedRootsCache } from './filesystem-auth'
import type { ChildProcess } from 'child_process'
import { rm } from 'fs/promises'
import { gitSpawn } from '../git/runner'
import { join, basename } from 'path'
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
      await rebuildAuthorizedRootsCache(store)
      notifyReposChanged(mainWindow)
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

      return { repo }
    }
  )

  ipcMain.handle('repos:remove', async (_event, args: { repoId: string }) => {
    store.removeRepo(args.repoId)
    await rebuildAuthorizedRootsCache(store)
    notifyReposChanged(mainWindow)
  })

  ipcMain.handle(
    'repos:update',
    (
      _event,
      args: {
        repoId: string
        updates: Partial<
          Pick<Repo, 'displayName' | 'badgeColor' | 'hookSettings' | 'worktreeBaseRef' | 'kind'>
        >
      }
    ) => {
      const updated = store.updateRepo(args.repoId, args.updates)
      if (updated) {
        notifyReposChanged(mainWindow)
      }
      return updated
    }
  )

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
            return updated
          }
        }
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
      await rebuildAuthorizedRootsCache(store)
      notifyReposChanged(mainWindow)
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
