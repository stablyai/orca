import { ipcMain } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ensureHistoryDir,
  hashWorktreeId,
  historyFilename,
  resolveShellKind
} from '../terminal-history'

function isENOENT(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Reads a worktree's persisted shell history file (raw content); null when the shell has no HISTFILE support yet (fish/pwsh/powershell/cmd) or nothing has been written yet. */
export async function readTerminalHistoryFile(args: {
  worktreeId: string
  shellPath: string
  wslDistro?: string
}): Promise<string | null> {
  const shell = resolveShellKind(args.shellPath)
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
    return await readFile(histFilePath, 'utf-8')
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
    async (_event, args: { worktreeId: string; shellPath: string; wslDistro?: string }) => {
      if (typeof args?.worktreeId !== 'string' || typeof args?.shellPath !== 'string') {
        return null
      }
      return readTerminalHistoryFile(args)
    }
  )
}
