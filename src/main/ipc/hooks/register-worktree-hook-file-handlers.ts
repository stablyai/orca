import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { isFolderRepo } from '../../../shared/repo-kind'
import { joinWorktreeRelativePath } from '../../runtime/runtime-relative-paths'
import { getSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { isENOENT } from '../filesystem-path-containment'
import { parseOrcaYaml } from '../../hooks'
import { readIssueCommand, writeIssueCommand } from '../../issue-command-file'
import { resolveRepoForExecutionHost } from '../worktrees/repo-host-ownership'
import type { WorktreeIpcContext } from '../worktrees/worktree-ipc-context'

export function registerWorktreeHookFileHandlers(context: WorktreeIpcContext): void {
  const { store } = context

  ipcMain.handle(
    'hooks:readIssueCommand',
    async (_event, args: { repoId: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return {
          status: 'ok',
          localContent: null,
          sharedContent: null,
          effectiveContent: null,
          localFilePath: '',
          source: 'none' as const
        }
      }
      if (repo.connectionId) {
        const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          return {
            status: 'error',
            localContent: null,
            sharedContent: null,
            effectiveContent: null,
            localFilePath: issueCommandPath,
            source: 'none' as const
          }
        }

        let status: 'ok' | 'error' = 'ok'
        let localContent: string | null = null
        let sharedContent: string | null = null
        try {
          const result = await fsProvider.readFile(issueCommandPath)
          localContent = result.isBinary ? null : result.content.trim() || null
        } catch (error) {
          if (!isENOENT(error)) {
            status = 'error'
          }
        }
        try {
          const result = await fsProvider.readFile(joinWorktreeRelativePath(repo.path, 'orca.yaml'))
          sharedContent = result.isBinary
            ? null
            : parseOrcaYaml(result.content)?.issueCommand?.trim() || null
        } catch (error) {
          if (!isENOENT(error)) {
            status = 'error'
          }
        }
        const effectiveContent = localContent ?? sharedContent
        return {
          status: localContent ? 'ok' : status,
          localContent,
          sharedContent,
          effectiveContent,
          localFilePath: issueCommandPath,
          source: localContent
            ? ('local' as const)
            : sharedContent
              ? ('shared' as const)
              : ('none' as const)
        }
      }
      return readIssueCommand(repo.path)
    }
  )

  ipcMain.handle(
    'hooks:writeIssueCommand',
    async (_event, args: { repoId: string; content: string; hostId?: ExecutionHostId }) => {
      const repo = resolveRepoForExecutionHost(store, args.repoId, args.hostId)
      if (!repo || isFolderRepo(repo)) {
        return
      }
      if (repo.connectionId) {
        const issueCommandPath = joinWorktreeRelativePath(repo.path, '.orca/issue-command')
        const fsProvider = getSshFilesystemProvider(repo.connectionId)
        if (!fsProvider) {
          throw new Error(
            'Remote filesystem unavailable. Reconnect the SSH target before retrying.'
          )
        }
        const trimmed = args.content.trim()
        if (!trimmed) {
          await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
            if (!isENOENT(error)) {
              throw error
            }
          })
          return
        }
        await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
        const gitignorePath = joinWorktreeRelativePath(repo.path, '.gitignore')
        try {
          const result = await fsProvider.readFile(gitignorePath)
          if (!result.isBinary && !/^\.orca\/?$/m.test(result.content)) {
            const separator = result.content.endsWith('\n') ? '' : '\n'
            await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
          }
        } catch (error) {
          if (!isENOENT(error)) {
            throw error
          }
          await fsProvider.writeFile(gitignorePath, '.orca\n')
        }
        await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
        return
      }
      writeIssueCommand(repo.path, args.content)
    }
  )
}
