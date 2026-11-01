import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import * as VisuallyHidden from 'radix-ui/visually-hidden'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { hasBoundedCommentBodyText } from '@/lib/comment-body-submit-state'
import { useAppStore } from '@/store'
import { jiraGetIssueForTarget, jiraUpdateIssueForTarget } from '@/runtime/runtime-jira-client'
import type {
  JiraEditField,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult
} from '../../../shared/jira/jira-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { JiraIssueMetadataBar, JiraIssueWorkspaceHeader } from './jira-issue-workspace-chrome'
import { JiraIssueCommentComposer, JiraIssueWorkspaceContent } from './jira-issue-workspace-content'
import { useJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'
import { getJiraReadIdentity } from '@/store/slices/jira-read-coordination'
import { defaultScopeHost } from '@/lib/default-creation-host'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { editedJiraIssueFields } from './jira-issue-workspace-hydration'
import { enqueueJiraIssueMutation, jiraIssueRequestScope } from './jira-issue-mutation-queue'
import { useJiraIssueMutationState } from './use-jira-issue-mutation-state'
import { useJiraIssueWorkspaceData } from './use-jira-issue-workspace-data'
import { useJiraIssueCommentSubmission } from './use-jira-issue-comment-submission'
import { useJiraIssueEditFields } from './use-jira-issue-edit-fields'
import {
  JiraIssueEditFieldsSection,
  jiraEditFieldPendingId
} from './jira-issue-edit-fields-section'
import {
  JiraIssueDescriptionAction,
  JiraIssueDescriptionEditor
} from './jira-issue-description-editing'
import { buildJiraEditFieldUpdate } from './jira-issue-edit-field-drafts'
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
  const owner = useMemo(
    () => (sourceContext ? taskSourceRuntimeTarget(sourceContext) : defaultScopeHost(settings)),
    [settings, sourceContext]
  )
  const runtimeContextKey = getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(owner))
  const mutationContextKey = getJiraReadIdentity(settings, sourceContext).contextKey
  const patchJiraIssue = useAppStore((s) => s.patchJiraIssue)
  const requestKey = jiraIssueRequestScope(issue, sourceContext, settings)
  const {
    comments,
    setComments,
    commentsLoading,
    commentsError,
    loadComments,
    transitions,
    transitionsLoading,
    transitionsError,
    loadTransitions,
    editedFieldsRef,
    fullIssue,
    issueLoading,
    labelsDraft,
    optimisticCommentsRef,
    pendingField,
    priorities,
    requestIdRef,
    commentDraft,
    commentSubmitting,
    setCommentDraft,
    setCommentSubmitting,
    setFullIssue,
    setLabelsDraft,
    setPendingField,
    setTitleDraft,
    titleDraft
  } = useJiraIssueWorkspaceData({ issue, owner, requestKey })
  const displayed = fullIssue ?? issue
  const siteId = displayed?.siteId ?? undefined
  const metadataKey = JSON.stringify([
    sourceContext ? getTaskSourceCacheScope(sourceContext) : owner,
    siteId,
    displayed?.key
  ])
  const handleSubmitComment = useJiraIssueCommentSubmission({
    commentDraft,
    commentSubmitting,
    displayed,
    optimisticCommentsRef,
    owner,
    requestIdRef,
    setCommentDraft,
    setCommentSubmitting,
    setComments
  })
  const editFields = useJiraIssueEditFields({
    issueKey: issue?.key,
    siteId: issue?.siteId,
    owner,
    requestKey
  })
  const reloadEditFields = editFields.reload
  useJiraIssueMutationState({
    scope: requestKey,
    issue,
    displayed,
    editedFieldsRef,
    setFullIssue,
    setTitleDraft,
    setLabelsDraft,
    // A new status can bring a different edit screen.
    onStatusSettled: () => {
      if (displayed) {
        void loadTransitions(displayed, requestIdRef.current)
        void reloadEditFields()
      }
    },
    onCommentsChanged: () => displayed && void loadComments(displayed, requestIdRef.current)
  })
  const mutateIssue = useCallback(
    async (
      field: string,
      updates: Parameters<typeof jiraUpdateIssueForTarget>[2],
      optimistic?: Partial<JiraIssue>
    ): Promise<JiraMutationResult> => {
      if (!displayed || pendingField || !requestKey) {
        return {
          ok: false,
          error: translate(
            'components.JiraIssueWorkspace.pendingChange',
            'Another issue change is in progress.'
          )
        }
      }
      setPendingField(field)
      const previous = displayed
      const requestId = requestIdRef.current
      for (const editable of optimistic ? editedJiraIssueFields(optimistic) : []) {
        editedFieldsRef.current.add(editable)
      }
      try {
        await enqueueJiraIssueMutation({
          scope: requestKey,
          previous,
          optimistic: optimistic ?? {},
          commentsChanged: Boolean(updates.transitionComment?.trim()),
          update: () => jiraUpdateIssueForTarget(owner, previous.key, updates, siteId),
          refresh: () => jiraGetIssueForTarget(owner, previous.key, previous.siteId),
          patchIssue: (patch) =>
            patchJiraIssue(previous.key, patch, {
              sourceContext,
              siteId: previous.siteId,
              contextKey: mutationContextKey
            })
        })
        return { ok: true }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.JiraIssueWorkspace.ea21952aa3',
                'Failed to update Jira issue.'
              )
        if (field !== 'transition') {
          toast.error(message)
        }
        return { ok: false, error: message }
      } finally {
        if (requestId === requestIdRef.current) {
          setPendingField(null)
        }
      }
    },
    [
      displayed,
      editedFieldsRef,
      patchJiraIssue,
      pendingField,
      mutationContextKey,
      owner,
      requestIdRef,
      requestKey,
      setPendingField,
      siteId,
      sourceContext
    ]
  )
  const { handleSaveTitle, handleSaveLabels, actionItems } = useJiraIssueWorkspaceActions({
    displayed,
    titleDraft,
    labelsDraft,
    setTitleDraft,
    mutateIssue
  })
  const saveEditField = useCallback(
    async (field: JiraEditField, update: JiraIssueUpdate): Promise<boolean> => {
      const result = await mutateIssue(jiraEditFieldPendingId(field), update)
      if (result.ok) {
        void reloadEditFields()
      }
      return result.ok
    },
    [mutateIssue, reloadEditFields]
  )
  // Scoped to the issue so switching issues leaves edit mode without an effect.
  const [editingDescriptionKey, setEditingDescriptionKey] = useState<string | null>(null)
  const descriptionField = editFields.fields?.find((field) => field.key === 'description')
  const editingDescription =
    descriptionField?.writable === true &&
    editingDescriptionKey !== null &&
    editingDescriptionKey === requestKey
  const saveDescription = useCallback(
    async (text: string): Promise<void> => {
      const update = descriptionField ? buildJiraEditFieldUpdate(descriptionField, text) : null
      if (!descriptionField || !update) {
        toast.error(
          translate('jira.editFields.required', '{{field}} is required.', {
            field: descriptionField?.name ?? 'Description'
          })
        )
        return
      }
      if (await saveEditField(descriptionField, update)) {
        setEditingDescriptionKey(null)
      }
    },
    [descriptionField, saveEditField]
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
              key={metadataKey}
              displayed={displayed}
              pendingField={pendingField}
              transitions={transitions}
              transitionsLoading={transitionsLoading}
              transitionsError={transitionsError}
              reloadTransitions={() => void loadTransitions(displayed, requestIdRef.current)}
              priorities={priorities}
              sourceContext={sourceContext}
              owner={owner}
              runtimeContextKey={runtimeContextKey}
              mutateIssue={mutateIssue}
            />

            <JiraIssueWorkspaceContent
              displayed={displayed}
              imageTarget={owner}
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
              editFieldsSection={
                <JiraIssueEditFieldsSection
                  state={editFields}
                  pendingField={pendingField}
                  owner={owner}
                  siteId={siteId}
                  onSave={saveEditField}
                />
              }
              descriptionAction={
                editingDescription ? null : (
                  <JiraIssueDescriptionAction
                    field={descriptionField}
                    issueUrl={displayed.url}
                    disabled={pendingField !== null}
                    onEdit={() => setEditingDescriptionKey(requestKey)}
                  />
                )
              }
              descriptionEditor={
                editingDescription && descriptionField ? (
                  <JiraIssueDescriptionEditor
                    field={descriptionField}
                    pending={pendingField === jiraEditFieldPendingId(descriptionField)}
                    onSave={(text) => void saveDescription(text)}
                    onCancel={() => setEditingDescriptionKey(null)}
                  />
                ) : null
              }
            />

            <JiraIssueCommentComposer
              commentDraft={commentDraft}
              setCommentDraft={setCommentDraft}
              commentSubmitting={commentSubmitting}
              canSubmitComment={hasBoundedCommentBodyText(commentDraft)}
              handleSubmitComment={() => void handleSubmitComment()}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
