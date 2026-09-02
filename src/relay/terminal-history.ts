import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { toLinuxPath } from '../shared/wsl-paths'
import { hashWorktreeId } from '../main/terminal-history-id'
import { dropInheritedOrcaHistFile } from '../main/worktree-history-file-path'
import {
  deleteFishHistoryFile,
  dropInheritedOrcaFishHistory,
  relayFishHistorySessionName,
  resolveFishHistoryDir
} from '../main/fish-history-session'

const HISTORY_ROOT = join(homedir(), '.orca-remote', 'terminal-history')

function historyFilename(shell: string): string | null {
  const name = basename(shell).toLowerCase()
  if (name.startsWith('bash')) {
    return 'bash_history'
  }
  if (name.startsWith('zsh')) {
    return 'zsh_history'
  }
  return null
}

export function injectRelayHistoryEnv(
  env: Record<string, string>,
  worktreeId: string,
  shell: string,
  options: { wsl?: boolean } = {}
): string | null {
  // Why first: same reason as the desktop path — an inherited ORCA_HISTFILE
  // would otherwise survive every early return below and let the remote wrapper
  // re-export another worktree's history path.
  delete env.ORCA_HISTFILE
  // Why: HISTFILE stays exported, so a relay (or a client) launched from an Orca
  // pane carries the launching worktree's path into this one; honouring it below
  // would scope every pane to that worktree's history file.
  dropInheritedOrcaHistFile(env)
  if (env.HISTFILE) {
    return null
  }
  // WSL's outer exe is wsl.exe, which matches no shell name; the guest login
  // shell reads HISTFILE regardless, so pick the file the desktop path picks.
  const filename = historyFilename(options.wsl ? 'bash' : shell)
  if (!filename) {
    return null
  }
  try {
    mkdirSync(HISTORY_ROOT, { recursive: true, mode: 0o700 })
    const rootStat = lstatSync(HISTORY_ROOT)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return null
    }
    const path = join(HISTORY_ROOT, `${hashWorktreeId(worktreeId)}-${filename}`)
    let existing: ReturnType<typeof lstatSync> | null = null
    try {
      const stat = lstatSync(path, { bigint: true })
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return null
      }
      existing = stat
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return null
      }
    }
    const fd = openSync(
      path,
      fsConstants.O_RDWR |
        fsConstants.O_CREAT |
        (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW),
      0o600
    )
    const actual = fstatSync(fd, { bigint: true })
    if (
      !actual.isFile() ||
      (existing && (actual.dev !== existing.dev || actual.ino !== existing.ino))
    ) {
      closeSync(fd)
      return null
    }
    closeSync(fd)
    // Why the same host file rather than a distro-scoped one: the guest reaches
    // it over drvfs, so `deleteRelayHistory` still reclaims it by host path.
    env.HISTFILE = options.wsl ? toLinuxPath(path) : path
    // Why a second variable: a remote macOS `/etc/zshrc` assigns HISTFILE
    // unconditionally before the wrapper runs, so the injected value is gone by
    // the first prompt. The wrapper restores it from here (#11044) — the same
    // contract the desktop PTY path uses. Under WSL it holds the guest-visible
    // path and stays out of WSLENV, matching the desktop; no wrapper reads it there.
    env.ORCA_HISTFILE = env.HISTFILE
    return HISTORY_ROOT
  } catch {
    return null
  }
}

export function deleteRelayHistory(worktreeId: string): void {
  try {
    const rootStat = lstatSync(HISTORY_ROOT)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return
    }
    for (const filename of ['bash_history', 'zsh_history']) {
      const path = join(HISTORY_ROOT, `${hashWorktreeId(worktreeId)}-${filename}`)
      try {
        if (!lstatSync(path).isSymbolicLink()) {
          unlinkSync(path)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
  } catch (error) {
    console.warn(
      `[pty:history] Failed to delete relay shell history: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/** fish keeps history in its own data dir under a session NAME, so the relay
 *  isolates it the same way the desktop app does and deletes by that name.
 *  No metadata file is needed: the name is a pure function of the worktree id. */
export function injectRelayFishHistoryEnv(env: Record<string, string>, worktreeId: string): void {
  // Own precondition, not the caller's: the check below may only honour a genuine
  // user value, and fish EXPORTS `fish_history` so an Orca-minted name arrives from
  // the relay's own env or the client's. `PtyHandler.buildSpawnEnv` already scrubs
  // every spawn path, so this is belt-and-braces for any other caller.
  dropInheritedOrcaFishHistory(env)
  if (env.fish_history) {
    return
  }
  env.fish_history = relayFishHistorySessionName(hashWorktreeId(worktreeId))
}

export function deleteRelayFishHistory(worktreeId: string, env?: NodeJS.ProcessEnv): void {
  deleteFishHistoryFile(relayFishHistorySessionName(hashWorktreeId(worktreeId)), [
    resolveFishHistoryDir(env)
  ])
}
