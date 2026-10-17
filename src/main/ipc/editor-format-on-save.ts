import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { runRepoFormatOnSave } from '../format-on-save-repo'
import {
  isFormatOnSaveConfigured,
  normalizeRepoFormatOnSaveSettings,
  type FormatOnSaveResult
} from '../../shared/format-on-save-command'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { resolveRepoOwnedWorktreePath } from './repo-owned-worktree-path'

type FormatOnSaveArgs = {
  repoId: string
  worktreePath: string
  filePath: string
}

export function registerEditorFormatOnSaveHandlers(store: Store): void {
  ipcMain.removeHandler('editor:formatOnSave')

  ipcMain.handle(
    'editor:formatOnSave',
    async (_event, rawArgs: unknown): Promise<FormatOnSaveResult> => {
      const args = parseFormatOnSaveArgs(rawArgs)
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        return { status: 'skipped', reason: 'not-configured' }
      }

      if (!isFormatOnSaveConfigured(normalizeRepoFormatOnSaveSettings(repo.formatOnSave))) {
        return { status: 'skipped', reason: 'not-configured' }
      }

      // Why: a remote repo is formatted by its own server through `files.formatOnSave`; running
      // its command here would answer for the wrong machine.
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (host && host.kind !== 'local') {
        return { status: 'skipped', reason: 'unsupported-host' }
      }

      // Why: proves the worktree is registered AND owned by this repo, so a
      // caller cannot pair one repo's configured command with another repo's worktree.
      const worktreePath = await resolveRepoOwnedWorktreePath(repo, store, args.worktreePath)

      return runRepoFormatOnSave({ repo, worktreePath, absoluteFilePath: args.filePath })
    }
  )
}

function parseFormatOnSaveArgs(rawArgs: unknown): FormatOnSaveArgs {
  const args = (rawArgs ?? {}) as Partial<FormatOnSaveArgs>
  const repoId = typeof args.repoId === 'string' ? args.repoId : ''
  const worktreePath = typeof args.worktreePath === 'string' ? args.worktreePath : ''
  const filePath = typeof args.filePath === 'string' ? args.filePath : ''

  if (!repoId || !worktreePath || !filePath) {
    throw new Error('Format on save requires a repo, worktree, and file path.')
  }
  if (filePath.includes('\0')) {
    throw new Error('Access denied: invalid file path')
  }

  return { repoId, worktreePath, filePath }
}
