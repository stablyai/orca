import { ipcMain } from 'electron'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getSetupCommandSource } from '../../hooks'
import { getLocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { createSetupRunnerScript } from '../../worktree-runner-script'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

type PrepareSetupRunnerResult = {
  status: 'ok' | 'error'
  setup: ReturnType<typeof createSetupRunnerScript> | null
  setupScript?: string
  setupScriptSource?: 'yaml' | 'local' | 'both'
  reason?: 'no-setup-configured' | 'folder-repo' | 'remote-host' | 'runner-failed'
  message?: string
}

/** Existing worktrees reuse the create-path setup runner for a manual re-run (#10015). */
export function registerWorktreeSetupRunnerHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:prepareSetupRunner',
    (
      _event,
      args: { repoId: string; worktreePath: string; hostId?: ExecutionHostId }
    ): PrepareSetupRunnerResult => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo) {
        const matches = store.getRepos().filter((entry) => entry.id === args.repoId)
        if (matches.length > 1) {
          return {
            status: 'error',
            setup: null,
            reason: 'runner-failed',
            message:
              'This project exists on multiple hosts; retry from the workspace list of the host that owns it.'
          }
        }
        throw new Error(`Repo not found: ${args.repoId}`)
      }
      if (isFolderRepo(repo)) {
        return { status: 'ok', setup: null, reason: 'folder-repo' }
      }
      // Runtime-host repos have no connectionId, so gate on the execution host.
      if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
        return {
          status: 'error',
          setup: null,
          reason: 'remote-host',
          message:
            'Run setup script is not yet supported for remote worktrees. Create a new worktree to run setup on that host, or open a local clone.'
        }
      }

      let commandSource: ReturnType<typeof getSetupCommandSource>
      try {
        // Prefer the worktree's orca.yaml so branch-specific setup matches create.
        commandSource = getSetupCommandSource(repo, args.worktreePath)
      } catch (error) {
        return {
          status: 'error',
          setup: null,
          reason: 'runner-failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }

      const setupScript = commandSource?.command.trim()
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
        return { status: 'ok', setup, setupScript, setupScriptSource: commandSource?.source }
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
