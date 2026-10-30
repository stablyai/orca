import { taskProviderErrorMessage } from '@/lib/task-provider-error-copy'
import React, { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'

import { IssueMarkdownDescriptionEditor } from '@/components/editor/IssueMarkdownDescriptionEditor'
import { IssueTitleField } from '@/components/editor/IssueTitleField'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'
import { linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getIssueTextSavePlan, type IssueTextField } from './issue-text-save-plan'
import { createIssueTextDraftState, resolveIssueTextDraftState } from './issue-text-draft-state'
import { translate } from '@/i18n/i18n'
import { defaultScopeSource } from '@/lib/default-creation-host'

type LinearIssueTextEditorProps = {
  issue: LinearIssue
  onIssueChange: (patch: Pick<LinearIssue, 'title'> | Pick<LinearIssue, 'description'>) => void
  density?: 'page' | 'drawer'
  fields?: 'all' | 'title' | 'description'
  sourceContext?: TaskSourceContext | null
}

export function LinearIssueTextEditor({
  issue,
  onIssueChange,
  density = 'page',
  fields = 'all',
  sourceContext
}: LinearIssueTextEditorProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? defaultScopeSource(settings)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const [draftState, setDraftState] = useState(() => createIssueTextDraftState(issue))
  const [savingField, setSavingField] = useState<IssueTextField | null>(null)
  const lastIssueIdRef = useRef(issue.id)
  const mountedRef = useMountedRef()
  const resolvedDraftState = resolveIssueTextDraftState(draftState, issue)
  const issueChanged = draftState.issueId !== issue.id
  if (resolvedDraftState !== draftState) {
    // Reconcile untouched drafts before paint without clobbering unsaved fields when Linear pushes changes.
    setDraftState(resolvedDraftState)
    if (issueChanged && savingField !== null) {
      setSavingField(null)
    }
    lastIssueIdRef.current = issue.id
  }
  const titleDraft = resolvedDraftState.title
  const descriptionDraft = resolvedDraftState.description
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const updateTitleDraft = useCallback(
    (title: string): void => {
      setDraftState((current) => ({
        ...resolveIssueTextDraftState(current, issue),
        title
      }))
    },
    [issue]
  )
  const updateDescriptionDraft = useCallback(
    (description: string): void => {
      setDraftState((current) => ({
        ...resolveIssueTextDraftState(current, issue),
        description
      }))
    },
    [issue]
  )

  const saveField = useCallback(
    async (field: IssueTextField, descriptionOverride?: string) => {
      const savePlan = getIssueTextSavePlan({
        descriptionDraft: descriptionOverride ?? descriptionDraft,
        field,
        issue: { description: issue.description, title: issue.title },
        titleDraft
      })
      if (savePlan.kind === 'empty-title') {
        updateTitleDraft(issue.title)
        toast.error(
          translate('auto.components.LinearIssueTextEditor.1e08a1ec80', 'Title is required')
        )
        return
      }
      if (savePlan.kind === 'unchanged') {
        return
      }

      const { patch } = savePlan
      setSavingField(field)
      onIssueChange(patch)
      patchLinearIssue(issue.id, patch)
      try {
        const result = await linearUpdateIssue(providerSettings, issue.id, patch, issue.workspaceId)
        if (!result.ok) {
          throw new Error(taskProviderErrorMessage(result))
        }
      } catch (error) {
        const revert =
          field === 'title'
            ? ({ title: issue.title } as const)
            : ({ description: issue.description ?? '' } as const)
        const stillEditingIssue = mountedRef.current && lastIssueIdRef.current === issue.id
        if (stillEditingIssue) {
          onIssueChange(revert)
        }
        patchLinearIssue(issue.id, revert)
        if (stillEditingIssue) {
          if (field === 'title') {
            updateTitleDraft(issue.title)
          } else {
            updateDescriptionDraft(issue.description ?? '')
          }
        }
        toast.error(
          error instanceof Error
            ? error.message
            : field === 'title'
              ? translate('taskProviders.linear.titleUpdateFailed', 'Failed to update title')
              : translate(
                  'taskProviders.linear.descriptionUpdateFailed',
                  'Failed to update description'
                )
        )
      } finally {
        if (mountedRef.current && lastIssueIdRef.current === issue.id) {
          setSavingField(null)
        }
      }
    },
    [
      descriptionDraft,
      issue.description,
      issue.id,
      issue.title,
      issue.workspaceId,
      mountedRef,
      onIssueChange,
      patchLinearIssue,
      providerSettings,
      titleDraft,
      updateDescriptionDraft,
      updateTitleDraft
    ]
  )

  const saveDescriptionValue = useCallback(
    (value: string) => {
      updateDescriptionDraft(value)
      void saveField('description', value)
    },
    [saveField, updateDescriptionDraft]
  )

  const titleClass =
    density === 'page'
      ? 'text-[28px] font-semibold leading-tight'
      : 'text-[15px] font-semibold leading-tight'
  return (
    <div className="min-w-0">
      {fields !== 'description' ? (
        <IssueTitleField
          value={titleDraft}
          onChange={updateTitleDraft}
          onSave={() => void saveField('title')}
          saving={savingField === 'title'}
          className={titleClass}
        />
      ) : null}

      {fields !== 'title' ? (
        <div className="relative">
          <IssueMarkdownDescriptionEditor
            value={descriptionDraft}
            imageUrls={issue.descriptionImageUrls}
            onChange={updateDescriptionDraft}
            onSave={saveDescriptionValue}
            density={density}
            disabled={savingField === 'description'}
            submitShortcutLabel={submitShortcutLabel}
          />
        </div>
      ) : null}
    </div>
  )
}
