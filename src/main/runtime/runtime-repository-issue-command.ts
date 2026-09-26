import type { GitRuntimeOptions } from '../git/git-runtime-options'
import type { Repo } from '../../shared/repo-types'
import { parseOrcaYaml } from '../hooks'
import {
  getRepoCommandRelativePath,
  isIssueCommandIgnoredByGit,
  readIssueCommand,
  writeIssueCommand
} from '../issue-command-file'
import { REPO_COMMAND_YAML_KEY, type RepoCommandKind } from '../../shared/repo-command-kind'
import { isENOENT } from '../ipc/filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import { isFolderRepo } from '../../shared/repo-kind'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

type RuntimeRepositoryIssueCommandDeps = {
  resolveRepo: (selector: string) => Promise<Repo>
  getLocalGitArgs: (repo: Repo) => [] | [GitRuntimeOptions]
}

export class RuntimeRepositoryIssueCommand {
  constructor(private readonly deps: RuntimeRepositoryIssueCommandDeps) {}

  async read(repoSelector: string, kind: RepoCommandKind = 'issue') {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: '',
        source: 'none' as const
      }
    }
    if (!repo.connectionId) {
      return readIssueCommand(repo.path, kind)
    }
    const issueCommandPath = joinWorktreeRelativePath(repo.path, getRepoCommandRelativePath(kind))
    const fsProvider = getSshFilesystemProvider(repo.connectionId)
    if (!fsProvider) {
      return {
        localContent: null,
        sharedContent: null,
        effectiveContent: null,
        localFilePath: issueCommandPath,
        source: 'none' as const
      }
    }
    const localContent = await readRemoteOverride(fsProvider, issueCommandPath)
    const sharedContent = await readRemoteShared(fsProvider, repo.path, kind)
    return {
      localContent,
      sharedContent,
      effectiveContent: localContent ?? sharedContent,
      localFilePath: issueCommandPath,
      source: localContent
        ? ('local' as const)
        : sharedContent
          ? ('shared' as const)
          : ('none' as const)
    }
  }

  /** Save a private override on its execution host; blank content restores the shared command. */
  async write(
    repoSelector: string,
    content: string,
    kind: RepoCommandKind = 'issue'
  ): Promise<{ ok: true }> {
    const repo = await this.deps.resolveRepo(repoSelector)
    if (isFolderRepo(repo)) {
      return { ok: true }
    }
    if (!repo.connectionId) {
      await writeIssueCommand(
        repo.path,
        content,
        () => this.deps.getLocalGitArgs(repo)[0] ?? {},
        kind
      )
      return { ok: true }
    }
    const issueCommandPath = joinWorktreeRelativePath(repo.path, getRepoCommandRelativePath(kind))
    const fsProvider = getSshFilesystemProvider(repo.connectionId)
    if (!fsProvider) {
      return { ok: true }
    }
    const trimmed = content.trim()
    if (!trimmed) {
      await fsProvider.deletePath(issueCommandPath, false).catch((error: unknown) => {
        if (!isENOENT(error)) {
          throw error
        }
      })
      return { ok: true }
    }
    await fsProvider.createDir(joinWorktreeRelativePath(repo.path, '.orca'))
    if (!(await isIssueCommandIgnoredByGit(repo.path, repo.connectionId, {}, kind))) {
      await ensureRemoteOrcaDirIgnored(fsProvider, repo.path)
    }
    await fsProvider.writeFile(issueCommandPath, `${trimmed}\n`)
    return { ok: true }
  }
}

async function readRemoteOverride(
  fsProvider: IFilesystemProvider,
  issueCommandPath: string
): Promise<string | null> {
  try {
    const result = await fsProvider.readFile(issueCommandPath)
    return result.isBinary ? null : result.content.trim() || null
  } catch {
    return null
  }
}

async function readRemoteShared(
  fsProvider: IFilesystemProvider,
  repoPath: string,
  kind: RepoCommandKind
): Promise<string | null> {
  try {
    const result = await fsProvider.readFile(joinWorktreeRelativePath(repoPath, 'orca.yaml'))
    return result.isBinary
      ? null
      : parseOrcaYaml(result.content)?.[REPO_COMMAND_YAML_KEY[kind]]?.trim() || null
  } catch {
    return null
  }
}

async function ensureRemoteOrcaDirIgnored(
  fsProvider: IFilesystemProvider,
  repoPath: string
): Promise<void> {
  const gitignorePath = joinWorktreeRelativePath(repoPath, '.gitignore')
  let result: Awaited<ReturnType<IFilesystemProvider['readFile']>>
  try {
    result = await fsProvider.readFile(gitignorePath)
  } catch (error) {
    if (!isENOENT(error)) {
      console.warn('[runtime] Could not inspect remote .gitignore for .orca', error)
      return
    }
    try {
      await fsProvider.writeFile(gitignorePath, '.orca\n')
    } catch (writeError) {
      console.warn('[runtime] Could not update remote .gitignore to exclude .orca', writeError)
    }
    return
  }
  if (result.isBinary || /^\.orca\/?$/m.test(result.content)) {
    return
  }
  const separator = result.content.endsWith('\n') ? '' : '\n'
  try {
    await fsProvider.writeFile(gitignorePath, `${result.content}${separator}.orca\n`)
  } catch (writeError) {
    console.warn('[runtime] Could not update remote .gitignore to exclude .orca', writeError)
  }
}
