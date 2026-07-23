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

// Why: matches LocalPtyProvider/daemon's `process.env.SHELL || '/bin/zsh'` spawn default;
// Windows has no POSIX-style shared default HISTFILE, so it has none here.
function resolveDefaultLocalShellKind(): ShellKind {
  if (process.platform === 'win32') {
    return 'unknown'
  }
  return resolveShellKind(process.env.SHELL || '/bin/zsh')
}

// Why: shellPath omitted means the host default login shell, resolved here rather than
// by the caller; local-filesystem only, SSH worktrees must skip this (remote HISTFILE).
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
