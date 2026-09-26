import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { useAppStore } from '@/store'
import {
  businessmapAddCardComment,
  businessmapGetCard,
  businessmapIssueComments
} from '@/runtime/runtime-businessmap-client'
import { useBusinessmapCardMutations } from './use-businessmap-card-mutations'
import type { BusinessmapCard, BusinessmapComment } from '../../../shared/businessmap-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { LoaderCircle, X, ArrowRight, ExternalLink } from 'lucide-react'

type BusinessmapCardWorkspaceProps = {
  card: BusinessmapCard | null
  onUse: (card: BusinessmapCard) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export default function BusinessmapCardWorkspace({
  card,
  onUse,
  onClose,
  sourceContext
}: BusinessmapCardWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const [fullCard, setFullCard] = useState<BusinessmapCard | null>(null)
  const [cardLoading, setCardLoading] = useState(false)
  const [comments, setComments] = useState<BusinessmapComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [descriptionDraft, setDescriptionDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)

  const displayed = fullCard ?? card

  useEffect(() => {
    if (!card) {
      setFullCard(null)
      setCardLoading(false)
      setComments([])
      setCommentsError(null)
      setCommentDraft('')
      setPendingField(null)
      setCommentSubmitting(false)
      return
    }
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setFullCard(card)
    setPendingField(null)
    setCommentSubmitting(false)
    setTitleDraft(card.title)
    setDescriptionDraft(card.description ?? '')
    setComments([])
    setCommentsError(null)
    setCardLoading(true)
    void businessmapGetCard(providerSettings, card.id)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          setFullCard(result)
          setTitleDraft(result.title)
          setDescriptionDraft(result.description ?? '')
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setCardLoading(false)
        }
      })
    setCommentsLoading(true)
    void businessmapIssueComments(providerSettings, card.id)
      .then((fetched) => {
        if (requestId === requestIdRef.current) {
          setComments(fetched)
        }
      })
      .catch((error) => {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      })
  }, [card, providerSettings])

  const { handleSaveTitle, handleSaveDescription } = useBusinessmapCardMutations({
    displayed,
    pendingField,
    providerSettings,
    titleDraft,
    descriptionDraft,
    requestIdRef,
    setFullCard,
    setPendingField
  })
  const handleSubmitComment = useCallback(async (): Promise<void> => {
    if (!displayed || commentSubmitting) {
      return
    }
    const bodyState = getCommentBodySubmitState(commentDraft)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.JiraIssueWorkspace.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setCommentSubmitting(true)
    const requestId = requestIdRef.current
    try {
      const result = await businessmapAddCardComment(providerSettings, displayed.id, bodyState.body)
      if (!result.ok) {
        throw new Error(result.error)
      }
      if (requestId !== requestIdRef.current) {
        return
      }
      const comment: BusinessmapComment = {
        id: result.id,
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: { displayName: 'You' }
      }
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      if (requestId !== requestIdRef.current) {
        return
      }
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      if (requestId === requestIdRef.current) {
        setCommentSubmitting(false)
      }
    }
  }, [commentDraft, commentSubmitting, displayed, providerSettings])
  const canSubmitComment = hasBoundedCommentBodyText(commentDraft)

  return (
    <Sheet open={card !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full sm:max-w-[640px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.BusinessmapCardWorkspace.title', 'Businessmap card')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.BusinessmapCardWorkspace.description',
              'Preview, edit, and start work from the selected card.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex flex-none items-center justify-between gap-2 border-b border-border/50 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-mono">#{displayed.id}</span>
                  <span className="truncate">
                    {displayed.column.name}
                    {displayed.lane ? ` · ${displayed.lane.name}` : ''}
                  </span>
                  {cardLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
                </div>
                <h2 className="mt-1 truncate text-sm font-semibold text-foreground">
                  {displayed.title}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => onUse(displayed)}>
                  <ArrowRight className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => void window.api.shell.openUrl(displayed.url)}
                >
                  <ExternalLink className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={onClose}>
                  <X className="size-4" />
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-sleek">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.jiraSortTitle', 'Title')}
              </label>
              <div className="mt-1 flex gap-2">
                <Input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  className="h-8"
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pendingField !== null}
                  onClick={handleSaveTitle}
                >
                  {translate('auto.components.BusinessmapCardWorkspace.save', 'Save')}
                </Button>
              </div>
              <label className="mt-3 block text-[11px] font-medium text-muted-foreground">
                {translate(
                  'auto.components.BusinessmapCardWorkspace.descriptionLabel',
                  'Description'
                )}
              </label>
              <div className="mt-1 flex flex-col gap-2">
                <Textarea
                  value={descriptionDraft}
                  onChange={(event) => setDescriptionDraft(event.target.value)}
                  className="min-h-20"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={pendingField !== null}
                  onClick={handleSaveDescription}
                >
                  {translate('auto.components.BusinessmapCardWorkspace.save', 'Save')}
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {displayed.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
                {displayed.assignee ? (
                  <span className="text-[11px] text-muted-foreground">
                    {displayed.assignee.displayName}
                  </span>
                ) : null}
              </div>
              <div className="mt-4">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {translate('auto.components.JiraIssueWorkspace.comments', 'Comments')}
                </div>
                {commentsLoading ? (
                  <div className="mt-2 space-y-2">
                    {[0, 1].map((index) => (
                      <div key={index} className="h-10 animate-pulse rounded bg-muted/40" />
                    ))}
                  </div>
                ) : commentsError ? (
                  <p className="mt-2 text-xs text-destructive">{commentsError}</p>
                ) : comments.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {translate(
                      'auto.components.BusinessmapCardWorkspace.noComments',
                      'No comments yet.'
                    )}
                  </p>
                ) : (
                  <div className="mt-2 space-y-2">
                    {comments.map((comment) => (
                      <div
                        key={comment.id}
                        className="rounded-md border border-border/50 bg-muted/30 px-2.5 py-2"
                      >
                        <div className="text-[11px] text-muted-foreground">
                          {comment.user?.displayName ?? ''}
                        </div>
                        <div className="mt-1 text-xs text-foreground">{comment.body}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-none items-center gap-2 border-t border-border/50 px-4 py-2.5">
              <Input
                value={commentDraft}
                onChange={(event) => setCommentDraft(event.target.value)}
                placeholder={translate(
                  'auto.components.JiraIssueWorkspace.addComment',
                  'Add a comment…'
                )}
                className="h-8"
              />
              <Button
                size="sm"
                disabled={!canSubmitComment || commentSubmitting}
                onClick={() => void handleSubmitComment()}
              >
                {commentSubmitting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  translate('auto.components.BusinessmapCardWorkspace.comment', 'Comment')
                )}
              </Button>
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
