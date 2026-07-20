import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ensureHistoryDir,
  hashWorktreeId,
  historyFilename,
  resolveShellKind,
  type ShellKind
} from '../terminal-history'

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Resolve the host's default login shell kind (matches LocalPtyProvider + the
 *  daemon adapter, which both spawn `process.env.SHELL || '/bin/zsh'` on POSIX).
 *  Windows has no POSIX-style shared default HISTFILE, so it has no default here. */
function resolveDefaultLocalShellKind(): ShellKind {
  if (process.platform === 'win32') {
    return 'unknown'
  }
  return resolveShellKind(process.env.SHELL || '/bin/zsh')
}

/** Reads a worktree's persisted shell history file. Returns the raw content and the
 *  resolved shell kind, or null when the shell has no HISTFILE support (fish/pwsh/
 *  powershell/cmd) or nothing has been written yet.
 *
 *  When `shellPath` is omitted the host default login shell is resolved — this is the
 *  dominant case (a plain terminal on the OS login shell), where the renderer has no
 *  explicit shell override to report. An explicit `shellPath` is honored strictly (a
 *  fish override reads no bash/zsh history), so the default only kicks in when absent.
 *
 *  Local-filesystem read only: SSH-hosted worktrees write their HISTFILE on the remote
 *  host, so callers must skip this for remote worktrees (see task-10 report). */
export async function readTerminalHistoryFile(args: {
  worktreeId: string
  shellPath?: string
  wslDistro?: string
}): Promise<{ content: string; shell: 'bash' | 'zsh' } | null> {
  const shell = args.shellPath ? resolveShellKind(args.shellPath) : resolveDefaultLocalShellKind()
  const filename = historyFilename(shell)
  if (!filename) {
    return null
  }
  const worktreeHash = hashWorktreeId(args.worktreeId)
  const histDir = ensureHistoryDir(worktreeHash, args.wslDistro)
  if (!histDir) {
    return null
  }
  const histFilePath = join(histDir, filename)
  try {
    const content = await readFile(histFilePath, 'utf-8')
    // filename is non-null only for bash/zsh, so the narrow is sound.
    return { content, shell: shell as 'bash' | 'zsh' }
  } catch (error) {
    if (isENOENT(error)) {
      return null
    }
    throw error
  }
}

export function registerTerminalHistoryFileHandlers(): void {
  ipcMain.handle(
    'terminal:readHistoryFile',
    async (_event, args: { worktreeId: string; shellPath?: string; wslDistro?: string }) => {
      if (typeof args?.worktreeId !== 'string') {
        return null
      }
      if (args.shellPath !== undefined && typeof args.shellPath !== 'string') {
        return null
      }
      if (args.wslDistro !== undefined && typeof args.wslDistro !== 'string') {
        return null
      }
      return readTerminalHistoryFile(args)
    }
  )
}
