import React from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { AsanaComment } from '../../../shared/types'
import { formatRelativeTime } from './asana-task-drawer-format'

type AsanaTaskCommentsProps = {
  comments: AsanaComment[]
  commentsLoading: boolean
  commentsError: string | null
  onRetry: () => void
}

export function AsanaTaskComments({
  comments,
  commentsLoading,
  commentsError,
  onRetry
}: AsanaTaskCommentsProps): React.JSX.Element {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.AsanaIssueWorkspace.d79323a259', 'Comments')}
          </span>
          {comments.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">{comments.length}</span>
          ) : null}
        </div>
        {commentsError ? (
          <Button
            variant="outline"
            size="xs"
            onClick={onRetry}
            disabled={commentsLoading}
            className="gap-1"
          >
            {commentsLoading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.AsanaIssueWorkspace.e43b2f6250', 'Retry')}
          </Button>
        ) : null}
      </div>
      {commentsError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {commentsError}
        </div>
      ) : commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.AsanaIssueWorkspace.58eb8f7b03', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <div key={comment.gid} className="rounded-md border border-border/50 bg-muted/20">
              <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[13px] font-semibold text-foreground">
                  {comment.user?.name ?? 'Unknown'}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatRelativeTime(comment.createdAt)}
                </span>
              </div>
              <div className="px-3 py-2">
                <CommentMarkdown content={comment.text} className="text-[13px] leading-relaxed" />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
