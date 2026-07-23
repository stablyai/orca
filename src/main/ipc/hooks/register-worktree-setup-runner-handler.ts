import { ipcMain } from 'electron'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getEffectiveHooks } from '../../hooks'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { createSetupRunnerScript } from '../../worktree-runner-script'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

type PrepareSetupRunnerResult = {
  status: 'ok' | 'error'
  setup: ReturnType<typeof createSetupRunnerScript> | null
  reason?: 'no-setup-configured' | 'folder-repo' | 'runner-failed'
  message?: string
}

/** Existing worktrees reuse the create-path setup runner for a manual re-run (#10015). */
export function registerWorktreeSetupRunnerHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:prepareSetupRunner',
    (_event, args: { repoId: string; worktreePath: string }): PrepareSetupRunnerResult => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo not found: ${args.repoId}`)
      }
      if (isFolderRepo(repo)) {
        return { status: 'ok', setup: null, reason: 'folder-repo' }
      }

      let setupScript: string | undefined
      try {
        // Prefer the worktree's orca.yaml so branch-specific setup matches create.
        const hooks = getEffectiveHooks(repo, args.worktreePath)
        setupScript = hooks?.scripts.setup?.trim()
      } catch (error) {
        return {
          status: 'error',
          setup: null,
          reason: 'runner-failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }

      if (!setupScript) {
        return { status: 'ok', setup: null, reason: 'no-setup-configured' }
      }

      try {
        const setup = createSetupRunnerScript(
          repo,
          args.worktreePath,
          setupScript,
          getLocalProjectWorktreeGitOptions(store, repo)
        )
        return { status: 'ok', setup }
      } catch (error) {
        return {
          status: 'error',
          setup: null,
          reason: 'runner-failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
}
