import { randomUUID } from 'node:crypto'
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { DiffComment, DiffReviewScope } from '../../shared/diff-comment-types'

export type CreateAgentDiffNoteParams = {
  worktree: string
  filePath: string
  lineNumber: number
  startLine?: number
  body: string
  rationale?: string
  authorName?: string
  scope?: DiffReviewScope
}

export type ListAgentDiffNotesParams = {
  worktree: string
  filePath?: string
}

export type DeleteAgentDiffNoteParams = {
  worktree: string
  commentId: string
}

// Why: agent-authored diff notes reuse the exact WorktreeMeta.diffComments
// array the human review-note system already persists, so no new storage or
// main→renderer push channel is needed — updateManagedWorktreeMeta already
// notifies the window and the renderer already renders whatever is in that
// array. Only the authoring surface (RPC/CLI) is new.
export class OrcaRuntimeWithAgentDiffNotes extends OrcaRuntimeWithResolveWaiter {
  async createAgentDiffNote(params: CreateAgentDiffNoteParams): Promise<DiffComment> {
    const worktree = await this.resolveWorktreeSelector(params.worktree)
    const comment: DiffComment = {
      id: randomUUID(),
      worktreeId: worktree.id,
      filePath: params.filePath,
      lineNumber: params.lineNumber,
      startLine: params.startLine,
      body: params.body,
      rationale: params.rationale,
      authorName: params.authorName,
      authoredBy: 'agent',
      scope: params.scope,
      createdAt: Date.now(),
      side: 'modified'
    }
    await this.updateManagedWorktreeMeta(`id:${worktree.id}`, {
      diffComments: [...(worktree.diffComments ?? []), comment]
    })
    return comment
  }

  async listAgentDiffNotes(params: ListAgentDiffNotesParams): Promise<{ comments: DiffComment[] }> {
    const worktree = await this.resolveWorktreeSelector(params.worktree)
    const comments = (worktree.diffComments ?? []).filter(
      (c) => c.authoredBy === 'agent' && (!params.filePath || c.filePath === params.filePath)
    )
    return { comments }
  }

  async deleteAgentDiffNote(params: DeleteAgentDiffNoteParams): Promise<{ deleted: boolean }> {
    const worktree = await this.resolveWorktreeSelector(params.worktree)
    const existing = worktree.diffComments ?? []
    const next = existing.filter((c) => c.id !== params.commentId)
    if (next.length === existing.length) {
      return { deleted: false }
    }
    await this.updateManagedWorktreeMeta(`id:${worktree.id}`, { diffComments: next })
    return { deleted: true }
  }
}
