import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { inspectSetupScriptImportCandidates } from '../../../shared/setup-script-imports'
import { joinWorktreeRelativePath } from '../../runtime/runtime-relative-paths'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { readFile, stat } from 'node:fs/promises'
import { isENOENT } from '../filesystem-path-containment'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

export function registerWorktreeHookInspectionHandler(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:inspectSetupScriptImports',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return []
      }

      return inspectSetupScriptImportCandidates(
        async (relativePath) => {
          const filePath = joinWorktreeRelativePath(repo.path, relativePath)
          if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId)
            if (!fsProvider) {
              return null
            }
            try {
              const result = await fsProvider.readFile(filePath)
              return result.isBinary ? null : result.content
            } catch {
              return null
            }
          }

          try {
            return await readFile(filePath, 'utf-8')
          } catch (error) {
            if (!isENOENT(error)) {
              console.warn('[hooks] Failed to inspect setup script import candidate:', error)
            }
            return null
          }
        },
        {
          fileExists: async (relativePath) => {
            const filePath = joinWorktreeRelativePath(repo.path, relativePath)
            if (repo.connectionId) {
              const fsProvider = getSshFilesystemProvider(repo.connectionId)
              if (!fsProvider) {
                return false
              }
              try {
                const fileStat = await fsProvider.stat(filePath)
                return fileStat.type !== 'directory'
              } catch {
                return false
              }
            }

            try {
              const fileStat = await stat(filePath)
              return !fileStat.isDirectory()
            } catch (error) {
              if (!isENOENT(error)) {
                console.warn('[hooks] Failed to stat setup script import candidate:', error)
              }
              return false
            }
          }
        }
      )
    }
  )
}
