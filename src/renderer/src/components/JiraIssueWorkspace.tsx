/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: Jira issue hydration, comments, transitions, priorities, and user options are loaded from provider IPC for the selected issue. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { VisuallyHidden } from 'radix-ui'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'

import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  jiraAddIssueComment,
  jiraGetIssue,
  jiraIssueComments,
  jiraListAssignableUsers,
  jiraListPriorities,
  jiraListTransitions,
  jiraUpdateIssue
} from '@/runtime/runtime-jira-client'
import type {
  JiraComment,
  JiraIssue,
  JiraPriority,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { JiraIssueMetadataBar, JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { JiraIssueCommentComposer, JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'
import {
  editedJiraIssueFields,
  mergeJiraIssueHydration,
  type EditableJiraIssueField
} from './jira-issue-workspace-hydration'

type JiraIssueWorkspaceProps = {
  issue: JiraIssue | null
  onUse: (issue: JiraIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export default function JiraIssueWorkspace({
  issue,
  onUse,
  onClose,
  sourceContext
}: JiraIssueWorkspaceProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const [fullIssue, setFullIssue] = useState<JiraIssue | null>(null)
  const [issueLoading, setIssueLoading] = useState(false)
  const [comments, setComments] = useState<JiraComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [transitions, setTransitions] = useState<JiraTransition[]>([])
  const [priorities, setPriorities] = useState<JiraPriority[]>([])
  const [users, setUsers] = useState<JiraUser[]>([])
  const [pendingField, setPendingField] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [labelsDraft, setLabelsDraft] = useState('')
  const [commentDraft, setCommentDraft] = useState('')
  const [commentSubmitting, setCommentSubmitting] = useState(false)
  const requestIdRef = useRef(0)
  const optimisticCommentsRef = useRef<JiraComment[]>([])

  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined
  // Why: the task page reads the open issue back out of the Jira store, so every
  // patch hands in a new object; only a different issue or host reloads detail.
  const requestKey = issue
    ? `${sourceContext?.hostId ?? settings?.activeRuntimeEnvironmentId ?? 'local'}:${issue.siteId ?? 'selected'}:${issue.key}`
    : null
  const loadedRequestKeyRef = useRef<string | null>(null)
  const editedFieldsRef = useRef(new Set<EditableJiraIssueField>())

  const loadComments = useCallback(
    async (targetIssue: JiraIssue, requestId: number): Promise<void> => {
      setCommentsLoading(true)
      setCommentsError(null)
      try {
        let fetched = await jiraIssueComments(providerSettings, targetIssue.key, targetIssue.siteId)
        if (requestId !== requestIdRef.current) {
          return
        }
        const optimistic = optimisticCommentsRef.current
        if (optimistic.length > 0) {
          const fetchedIds = new Set(fetched.map((comment) => comment.id))
          fetched = [...fetched, ...optimistic.filter((comment) => !fetchedIds.has(comment.id))]
        }
        setComments(fetched)
      } catch (error) {
        if (requestId === requestIdRef.current) {
          setCommentsError(error instanceof Error ? error.message : 'Failed to load comments.')
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setCommentsLoading(false)
        }
      }
    },
    [providerSettings]
  )

  useEffect(() => {
    if (!issue) {
      loadedRequestKeyRef.current = null
      setFullIssue(null)
      setIssueLoading(false)
      setComments([])
      setCommentsError(null)
      setTransitions([])
      setPriorities([])
      setUsers([])
      setCommentDraft('')
      optimisticCommentsRef.current = []
      return
    }
    if (loadedRequestKeyRef.current === requestKey) {
      return
    }
    loadedRequestKeyRef.current = requestKey

    requestIdRef.current += 1
    const requestId = requestIdRef.current
    optimisticCommentsRef.current = []
    editedFieldsRef.current = new Set()
    setFullIssue(issue)
    setTitleDraft(issue.title)
    setLabelsDraft(issue.labels.join(', '))
    setComments([])
    setCommentsError(null)
    setIssueLoading(true)

    void jiraGetIssue(providerSettings, issue.key, issue.siteId)
      .then((result) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        if (result) {
          const edited = new Set(editedFieldsRef.current)
          setFullIssue((current) => mergeJiraIssueHydration(result, current, edited))
          if (!edited.has('title')) {
            setTitleDraft(result.title)
          }
          if (!edited.has('labels')) {
            setLabelsDraft(result.labels.join(', '))
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (requestId === requestIdRef.current) {
          setIssueLoading(false)
        }
      })

    void Promise.all([
      jiraListTransitions(providerSettings, issue.key, issue.siteId),
      jiraListPriorities(providerSettings, issue.siteId),
      jiraListAssignableUsers(providerSettings, issue.key, undefined, issue.siteId)
    ])
      .then(([nextTransitions, nextPriorities, nextUsers]) => {
        if (requestId !== requestIdRef.current) {
          return
        }
        setTransitions(nextTransitions)
        setPriorities(nextPriorities)
        setUsers(nextUsers)
      })
      .catch(() => {})

    void loadComments(issue, requestId)
  }, [issue, loadComments, providerSettings, requestKey])

  // Why: the store entry always belongs to `target`, but local state only while
  // `target` is still the open issue (`requestId` has not moved on).
  const refreshIssue = useCallback(
    async (target: JiraIssue, requestId: number): Promise<void> => {
      try {
        const latest = await jiraGetIssue(providerSettings, target.key, target.siteId)
        if (latest) {
          patchJiraIssue(latest.key, latest, { sourceContext })
          if (requestId === requestIdRef.current) {
            setFullIssue(latest)
          }
        }
      } catch {
        // Keep the visible issue snapshot if refresh fails.
      }
    },
    [patchJiraIssue, providerSettings, sourceContext]
  )

  // Why: Jira only offers transitions out of the current status, so a status
  // change invalidates the list loaded when the issue opened.
  const refreshTransitions = useCallback(
    async (target: JiraIssue, requestId: number): Promise<void> => {
      try {
        const next = await jiraListTransitions(providerSettings, target.key, target.siteId)
        if (requestId === requestIdRef.current) {
          setTransitions(next)
        }
      } catch {
        // Keep the current list if the reload fails.
      }
    },
    [providerSettings]
  )

  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssue>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<void> => {
      if (!displayed || pendingField) {
        return
      }
      setPendingField(field)
      const previous = displayed
      // Why: the task page keeps this instance across selections, so continuations
      // must check they still belong to the issue this save started on.
      const requestId = requestIdRef.current
      for (const editable of optimistic ? editedJiraIssueFields(optimistic) : []) {
        editedFieldsRef.current.add(editable)
      }
      try {
        if (optimistic) {
          setFullIssue({ ...displayed, ...optimistic })
          patchJiraIssue(displayed.key, optimistic, { sourceContext })
        }
        const result = await jiraUpdateIssue(providerSettings, displayed.key, updates, siteId)
        if (!result.ok) {
          throw new Error(result.error)
        }
        await refreshIssue(previous, requestId)
        if (updates.transitionId) {
          await refreshTransitions(previous, requestId)
        }
      } catch (error) {
        patchJiraIssue(previous.key, previous, { sourceContext })
        if (requestId === requestIdRef.current) {
          setFullIssue(previous)
          setTitleDraft(previous.title)
          setLabelsDraft(previous.labels.join(', '))
        }
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
        )
      } finally {
        setPendingField(null)
      }
    },
    [
      displayed,
      patchJiraIssue,
      pendingField,
      refreshIssue,
      refreshTransitions,
      providerSettings,
      siteId,
      sourceContext
    ]
  )

  const handleSaveTitle = useCallback(() => {
    if (!displayed) {
      return
    }
    const title = titleDraft.trim()
    if (!title || title === displayed.title) {
      setTitleDraft(displayed.title)
      return
    }
    void mutateIssue('title', { title }, { title })
  }, [displayed, mutateIssue, titleDraft])

  const handleSaveLabels = useCallback(() => {
    if (!displayed) {
      return
    }
    const labels = labelsDraft
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
    void mutateIssue('labels', { labels }, { labels })
  }, [displayed, labelsDraft, mutateIssue])

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
    try {
      const result = await jiraAddIssueComment(
        providerSettings,
        displayed.key,
        bodyState.body,
        displayed.siteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      const comment: JiraComment = {
        id: result.id || createBrowserUuid(),
        body: bodyState.body,
        createdAt: new Date().toISOString(),
        user: { accountId: 'local', displayName: 'You' }
      }
      optimisticCommentsRef.current.push(comment)
      setComments((prev) => [...prev, comment])
      setCommentDraft('')
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.JiraIssueWorkspace.fa132c8aed', 'Failed to add comment.')
      )
    } finally {
      setCommentSubmitting(false)
    }
  }, [commentDraft, commentSubmitting, displayed, providerSettings])
  const canSubmitComment = hasBoundedCommentBodyText(commentDraft)

  const actionItems = useMemo(
    () => (displayed ? getJiraIssueWorkspaceActions(displayed) : []),
    [displayed]
  )

  return (
    <Sheet open={issue !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-[min(92vw,780px)] p-0 sm:max-w-[780px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <VisuallyHidden.Root asChild>
          <SheetTitle>
            {displayed?.title ??
              translate('auto.components.JiraIssueWorkspace.ef21405c6d', 'Jira issue')}
          </SheetTitle>
        </VisuallyHidden.Root>
        <VisuallyHidden.Root asChild>
          <SheetDescription>
            {translate(
              'auto.components.JiraIssueWorkspace.857bd2f88f',
              'Preview, edit, and start work from the selected issue.'
            )}
          </SheetDescription>
        </VisuallyHidden.Root>

        {displayed ? (
          <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
            <JiraIssueWorkspaceHeader
              displayed={displayed}
              issueLoading={issueLoading}
              onUse={onUse}
              onClose={onClose}
            />

            <JiraIssueMetadataBar
              displayed={displayed}
              pendingField={pendingField}
              transitions={transitions}
              priorities={priorities}
              users={users}
              mutateIssue={mutateIssue}
            />

            <JiraIssueWorkspaceContent
              displayed={displayed}
              titleDraft={titleDraft}
              setTitleDraft={setTitleDraft}
              labelsDraft={labelsDraft}
              setLabelsDraft={setLabelsDraft}
              handleSaveTitle={handleSaveTitle}
              handleSaveLabels={handleSaveLabels}
              pendingField={pendingField}
              comments={comments}
              commentsError={commentsError}
              commentsLoading={commentsLoading}
              retryComments={() => void loadComments(displayed, requestIdRef.current)}
              onUse={onUse}
              actionItems={actionItems}
            />

            <JiraIssueCommentComposer
              commentDraft={commentDraft}
              setCommentDraft={setCommentDraft}
              commentSubmitting={commentSubmitting}
              canSubmitComment={canSubmitComment}
              handleSubmitComment={() => void handleSubmitComment()}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
