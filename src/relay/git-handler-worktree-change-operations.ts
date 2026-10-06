import { GitHandlerOperationContext } from './git-handler-operation-context'
import { commitChangesRelay } from './git-handler-worktree-ops'
import { encodeGitPathspecs } from '../shared/git-pathspec-stdin'

export class GitHandlerWorktreeChangeOperations extends GitHandlerOperationContext {
  async stage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      await this.git(['add', '--', this.literalPathspec(filePath)], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async commit(params: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const message = params.message as string
    try {
      return await commitChangesRelay(this.git.bind(this), worktreePath, message)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async unstage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePath = params.filePath as string
    try {
      // Reset treats an unborn HEAD as an empty tree, preserving the working file.
      await this.git(['reset', '--quiet', '--', this.literalPathspec(filePath)], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async bulkStage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      if (filePaths.length === 0) {
        return
      }
      await this.git(['add', '--pathspec-from-file=-', '--pathspec-file-nul'], worktreePath, {
        stdin: encodeGitPathspecs(filePaths.map((filePath) => this.literalPathspec(filePath)))
      })
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async bulkUnstage(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const filePaths = params.filePaths as string[]
    try {
      if (filePaths.length === 0) {
        return
      }
      await this.git(
        ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'],
        worktreePath,
        { stdin: encodeGitPathspecs(filePaths.map((filePath) => this.literalPathspec(filePath))) }
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async abortMerge(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['merge', '--abort'], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async abortRebase(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    try {
      await this.git(['rebase', '--abort'], worktreePath)
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async checkout(params: Record<string, unknown>) {
    this.clearGitMutationReadCaches()
    const worktreePath = params.worktreePath as string
    const branch = params.branch as string
    // Defense-in-depth: reject `-`-prefixed branch tokens to block flag injection (this relay entrypoint is reachable independently of the RPC schema).
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-')) {
      throw new Error('invalid_branch_name')
    }
    try {
      await this.git(['checkout', branch, '--'], worktreePath)
      return { ok: true as const, branch }
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  async localBranches(params: Record<string, unknown>) {
    const worktreePath = params.worktreePath as string
    const { stdout } = await this.git(
      ['for-each-ref', '--format=%(HEAD)%09%(refname:short)', 'refs/heads/'],
      worktreePath
    )
    let current: string | null = null
    const branches: string[] = []
    for (const line of stdout.split('\n')) {
      if (line.length === 0) {
        continue
      }
      const [marker, name] = line.split('\t')
      if (!name) {
        continue
      }
      if (marker === '*') {
        current = name
      }
      branches.push(name)
    }
    branches.sort((a, b) => (a === current ? -1 : b === current ? 1 : 0))
    return { current, branches }
  }
}
