import hostedGitInfo from 'hosted-git-info'
import type { DockerEngineClientLike } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import type { DockerTarget } from '../docker/types'
import type { IGitProvider } from './types'
import type {
  GitBranchCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitFileStatus,
  GitStatusResult,
  GitWorktreeInfo
} from '../../shared/types'

export class DockerGitProvider implements IGitProvider {
  private target: DockerTarget
  private engine: DockerEngineClientLike

  constructor(target: DockerTarget, engine: DockerEngineClientLike = new DockerEngineClient()) {
    this.target = target
    this.engine = engine
  }

  getConnectionId(): string {
    return this.target.containerId
  }

  async getStatus(worktreePath: string): Promise<GitStatusResult> {
    const [status, conflictOperation] = await Promise.all([
      this.git(['status', '--porcelain=v2', '--untracked-files=all'], worktreePath),
      this.detectConflictOperation(worktreePath)
    ])
    return { entries: parseStatus(status.stdout), conflictOperation }
  }

  async getDiff(worktreePath: string, filePath: string, staged: boolean): Promise<GitDiffResult> {
    const args = staged ? ['diff', '--cached', '--', filePath] : ['diff', '--', filePath]
    const result = await this.git(args, worktreePath)
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: result.stdout,
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }

  async stageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.git(['add', '--', filePath], worktreePath)
  }

  async unstageFile(worktreePath: string, filePath: string): Promise<void> {
    await this.git(['restore', '--staged', '--', filePath], worktreePath)
  }

  async bulkStageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.git(['add', '--', ...filePaths], worktreePath)
  }

  async bulkUnstageFiles(worktreePath: string, filePaths: string[]): Promise<void> {
    await this.git(['restore', '--staged', '--', ...filePaths], worktreePath)
  }

  async discardChanges(worktreePath: string, filePath: string): Promise<void> {
    await this.git(['restore', '--', filePath], worktreePath)
  }

  async detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
    const gitDir = (await this.git(['rev-parse', '--git-dir'], worktreePath)).stdout.trim()
    const checks = await Promise.all([
      this.pathExists(worktreePath, `${gitDir}/MERGE_HEAD`),
      this.pathExists(worktreePath, `${gitDir}/CHERRY_PICK_HEAD`),
      this.pathExists(worktreePath, `${gitDir}/rebase-merge`),
      this.pathExists(worktreePath, `${gitDir}/rebase-apply`)
    ])
    if (checks[0]) {
      return 'merge'
    }
    if (checks[1]) {
      return 'cherry-pick'
    }
    if (checks[2] || checks[3]) {
      return 'rebase'
    }
    return 'unknown'
  }

  async getBranchCompare(worktreePath: string, baseRef: string): Promise<GitBranchCompareResult> {
    const mergeBase = (await this.git(['merge-base', baseRef, 'HEAD'], worktreePath)).stdout.trim()
    const names = await this.git(['diff', '--name-status', mergeBase, 'HEAD'], worktreePath)
    const entries = names.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [status, filePath, oldPath] = line.split('\t')
        return {
          path: filePath,
          status: parseBranchStatus(status),
          ...(oldPath ? { oldPath } : {})
        }
      })
    return {
      summary: {
        baseRef,
        baseOid: mergeBase,
        compareRef: 'HEAD',
        headOid: (await this.git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim(),
        mergeBase,
        changedFiles: entries.length,
        status: 'ready'
      },
      entries
    }
  }

  async getBranchDiff(
    worktreePath: string,
    baseRef: string,
    options?: { includePatch?: boolean; filePath?: string; oldPath?: string }
  ): Promise<GitDiffResult[]> {
    const args = ['diff', baseRef, 'HEAD']
    if (options?.filePath) {
      args.push('--', options.filePath)
    }
    const result = await this.git(args, worktreePath)
    return [
      {
        kind: 'text',
        originalContent: '',
        modifiedContent: result.stdout,
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    ]
  }

  async listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
    const result = await this.git(['worktree', 'list', '--porcelain'], repoPath)
    return parseWorktrees(result.stdout)
  }

  async addWorktree(
    repoPath: string,
    branchName: string,
    targetDir: string,
    options?: { base?: string; track?: boolean }
  ): Promise<void> {
    const args = ['worktree', 'add']
    if (options?.track) {
      args.push('--track')
    }
    args.push(targetDir, branchName)
    if (options?.base) {
      args.push(options.base)
    }
    await this.git(args, repoPath)
  }

  async removeWorktree(worktreePath: string, force?: boolean): Promise<void> {
    await this.git(
      ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
      this.target.workdir
    )
  }

  async exec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return this.git(args, cwd)
  }

  async isGitRepoAsync(dirPath: string): Promise<{ isRepo: boolean; rootPath: string | null }> {
    try {
      const rootPath = (await this.git(['rev-parse', '--show-toplevel'], dirPath)).stdout.trim()
      return { isRepo: true, rootPath }
    } catch {
      return { isRepo: false, rootPath: null }
    }
  }

  isGitRepo(_path: string): boolean {
    return true
  }

  async getRemoteFileUrl(
    worktreePath: string,
    relativePath: string,
    line: number
  ): Promise<string | null> {
    let remoteUrl: string
    try {
      remoteUrl = (await this.exec(['remote', 'get-url', 'origin'], worktreePath)).stdout.trim()
    } catch {
      return null
    }
    const info = hostedGitInfo.fromUrl(remoteUrl)
    if (!info) {
      return null
    }
    const browseUrl = info.browseFile(relativePath, { committish: 'main' })
    return browseUrl ? `${browseUrl}#L${line}` : null
  }

  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    const result = await this.engine.exec({
      containerId: this.target.containerId,
      args: ['git', ...args],
      cwd
    })
    return { stdout: result.stdout, stderr: result.stderr }
  }

  private async pathExists(cwd: string, targetPath: string): Promise<boolean> {
    try {
      await this.engine.exec({
        containerId: this.target.containerId,
        args: ['test', '-e', targetPath],
        cwd
      })
      return true
    } catch {
      return false
    }
  }
}

function parseStatus(stdout: string): GitStatusResult['entries'] {
  const entries: GitStatusResult['entries'] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), status: 'untracked', area: 'untracked' })
      continue
    }
    if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ')
      const xy = parts[1]
      const filePath = line.startsWith('2 ') ? line.split('\t')[1] : parts.slice(8).join(' ')
      if (xy[0] !== '.') {
        entries.push({ path: filePath, status: parseFileStatus(xy[0]), area: 'staged' })
      }
      if (xy[1] !== '.') {
        entries.push({ path: filePath, status: parseFileStatus(xy[1]), area: 'unstaged' })
      }
    }
  }
  return entries
}

function parseFileStatus(char: string): GitFileStatus {
  switch (char) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

function parseBranchStatus(char: string): 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' {
  return parseFileStatus(char[0]) as 'modified' | 'added' | 'deleted' | 'renamed' | 'copied'
}

function parseWorktrees(stdout: string): GitWorktreeInfo[] {
  const chunks = stdout.split(/\n\n+/).filter(Boolean)
  return chunks.map((chunk, index) => {
    const values = Object.fromEntries(
      chunk.split(/\r?\n/).map((line) => {
        const [key, ...rest] = line.split(' ')
        return [key, rest.join(' ')]
      })
    )
    return {
      path: values.worktree,
      head: values.HEAD,
      branch: values.branch?.replace(/^refs\/heads\//, '') ?? '',
      isBare: chunk.includes('\nbare'),
      isMainWorktree: index === 0
    }
  })
}
