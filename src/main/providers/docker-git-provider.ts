/* eslint-disable max-lines */
import hostedGitInfo from 'hosted-git-info'
import type { DockerEngineClientLike } from '../docker/docker-engine-client'
import { DockerEngineClient } from '../docker/docker-engine-client'
import type { DockerTarget } from '../docker/types'
import { resolveDefaultBaseRefViaExec } from '../git/repo'
import type { IGitProvider } from './types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareResult,
  GitBranchChangeStatus,
  GitConflictKind,
  GitConflictOperation,
  GitDiffResult,
  GitFileStatus,
  GitStatusEntry,
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
    const originalBlob = staged
      ? await this.readGitBlob(worktreePath, 'HEAD', filePath)
      : await this.readUnstagedLeftBlob(worktreePath, filePath)
    const modifiedContent = staged
      ? (await this.readGitIndexBlob(worktreePath, filePath)).content
      : await this.readWorkingTreeFile(worktreePath, filePath)

    return buildTextDiffResult(originalBlob.content, modifiedContent)
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
    const names = await this.git(
      ['diff', '--name-status', '-M', '-C', mergeBase, 'HEAD'],
      worktreePath
    )
    const entries = names.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseBranchChangeLine)
      .filter((entry): entry is GitBranchChangeEntry => entry !== null)
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
    const entries = options?.filePath
      ? [
          {
            path: options.filePath,
            status: 'modified' as const,
            ...(options.oldPath ? { oldPath: options.oldPath } : {})
          }
        ]
      : await this.loadBranchChanges(worktreePath, baseRef)

    if (options?.includePatch === false) {
      return entries.map(() => buildTextDiffResult('', ''))
    }

    return Promise.all(
      entries.map(async (entry) => {
        const originalContent = await this.readGitBlob(
          worktreePath,
          baseRef,
          entry.oldPath ?? entry.path
        )
        const modifiedContent = await this.readGitBlob(worktreePath, 'HEAD', entry.path)
        return buildTextDiffResult(originalContent.content, modifiedContent.content)
      })
    )
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
    const defaultBaseRef = await resolveDefaultBaseRefViaExec((argv) =>
      this.git(argv, worktreePath)
    )
    if (!defaultBaseRef) {
      return null
    }
    const defaultBranch = defaultBaseRef.replace(/^origin\//, '')
    const browseUrl = info.browseFile(relativePath, { committish: defaultBranch })
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

  private async loadBranchChanges(
    worktreePath: string,
    baseRef: string
  ): Promise<GitBranchChangeEntry[]> {
    const result = await this.git(
      ['diff', '--name-status', '-M', '-C', baseRef, 'HEAD'],
      worktreePath
    )
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseBranchChangeLine)
      .filter((entry): entry is GitBranchChangeEntry => entry !== null)
  }

  private async readUnstagedLeftBlob(
    worktreePath: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    const indexBlob = await this.readGitIndexBlob(worktreePath, filePath)
    if (indexBlob.exists) {
      return indexBlob
    }
    return this.readGitBlob(worktreePath, 'HEAD', filePath)
  }

  private async readGitIndexBlob(
    worktreePath: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    return this.readGitBlobSpec(worktreePath, `:${filePath}`)
  }

  private async readGitBlob(
    worktreePath: string,
    ref: string,
    filePath: string
  ): Promise<DockerGitBlobReadResult> {
    return this.readGitBlobSpec(worktreePath, `${ref}:${filePath}`)
  }

  private async readGitBlobSpec(
    worktreePath: string,
    spec: string
  ): Promise<DockerGitBlobReadResult> {
    try {
      return { content: (await this.git(['show', spec], worktreePath)).stdout, exists: true }
    } catch {
      return { content: '', exists: false }
    }
  }

  private async readWorkingTreeFile(worktreePath: string, filePath: string): Promise<string> {
    try {
      const result = await this.engine.exec({
        containerId: this.target.containerId,
        args: ['cat', '--', filePath],
        cwd: worktreePath
      })
      return result.stdout
    } catch {
      return ''
    }
  }
}

type DockerGitBlobReadResult = {
  content: string
  exists: boolean
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
      continue
    }
    if (line.startsWith('u ')) {
      const entry = parseUnmergedStatusLine(line)
      if (entry) {
        entries.push(entry)
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

function parseBranchChangeLine(line: string): GitBranchChangeEntry | null {
  const parts = line.split('\t')
  const rawStatus = parts[0] ?? ''
  const status = parseBranchStatus(rawStatus) as GitBranchChangeStatus

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = parts[1]
    const filePath = parts[2]
    if (!filePath) {
      return null
    }
    return { path: filePath, oldPath, status }
  }

  const filePath = parts[1]
  if (!filePath) {
    return null
  }
  return { path: filePath, status }
}

function parseUnmergedStatusLine(line: string): GitStatusEntry | null {
  const parts = line.split(' ')
  const xy = parts[1]
  const filePath = parts.slice(10).join(' ')
  if (!xy || !filePath) {
    return null
  }
  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  return {
    path: filePath,
    area: 'unstaged',
    status: conflictKind === 'both_deleted' ? 'deleted' : 'modified',
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

function buildTextDiffResult(originalContent: string, modifiedContent: string): GitDiffResult {
  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
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
