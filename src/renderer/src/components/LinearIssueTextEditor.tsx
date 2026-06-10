import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'

import { LinearIssueMarkdownDescriptionEditor } from '@/components/LinearIssueMarkdownDescriptionEditor'
import { useMountedRef } from '@/hooks/useMountedRef'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { linearUpdateIssue } from '@/runtime/runtime-linear-client'
import type { LinearIssue } from '../../../shared/types'
import {
  getLinearIssueTextSavePlan,
  type LinearIssueTextField
} from './linear-issue-text-save-plan'
import {
  createLinearIssueTextDraftState,
  resolveLinearIssueTextDraftState
} from './linear-issue-text-draft-state'
import { translate } from '@/i18n/i18n'

type LinearIssueTextEditorProps = {
  issue: LinearIssue
  onIssueChange: (patch: Pick<LinearIssue, 'title'> | Pick<LinearIssue, 'description'>) => void
  density?: 'page' | 'drawer'
  fields?: 'all' | 'title' | 'description'
}

function useAutosizeTextArea(value: string): React.RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const textarea = ref.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [value])

  return ref
}

export function LinearIssueTextEditor({
  issue,
  onIssueChange,
  density = 'page',
  fields = 'all'
}: LinearIssueTextEditorProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const patchLinearIssue = useAppStore((s) => s.patchLinearIssue)
  const [draftState, setDraftState] = useState(() => createLinearIssueTextDraftState(issue))
  const [savingField, setSavingField] = useState<LinearIssueTextField | null>(null)
  const lastIssueIdRef = useRef(issue.id)
  const mountedRef = useMountedRef()
  const resolvedDraftState = resolveLinearIssueTextDraftState(draftState, issue)
  const issueChanged = draftState.issueId !== issue.id
  if (resolvedDraftState !== draftState) {
    // Why: Linear can push updated title/description while another field has
    // unsaved edits; reconcile only untouched drafts before the next paint.
    setDraftState(resolvedDraftState)
    if (issueChanged && savingField !== null) {
      setSavingField(null)
    }
    lastIssueIdRef.current = issue.id
  }
  const titleDraft = resolvedDraftState.title
  const descriptionDraft = resolvedDraftState.description
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const titleRef = useAutosizeTextArea(titleDraft)
  const updateTitleDraft = useCallback(
    (title: string): void => {
      setDraftState((current) => ({
        ...resolveLinearIssueTextDraftState(current, issue),
        title
      }))
    },
    [issue]
  )
  const updateDescriptionDraft = useCallback(
    (description: string): void => {
      setDraftState((current) => ({
        ...resolveLinearIssueTextDraftState(current, issue),
        description
      }))
    },
    [issue]
  )

  const saveField = useCallback(
    async (field: LinearIssueTextField, descriptionOverride?: string) => {
      const savePlan = getLinearIssueTextSavePlan({
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
        const result = await linearUpdateIssue(settings, issue.id, patch, issue.workspaceId)
        if (!result.ok) {
          throw new Error(result.error)
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
            : translate(
                'auto.components.LinearIssueTextEditor.e8ff595db3',
                'Failed to update {{value0}}',
                { value0: field }
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
      settings,
      titleDraft,
      updateDescriptionDraft,
      updateTitleDraft
    ]
  )

  const handleDescriptionKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      event.preventDefault()
      event.currentTarget.blur()
    },
    []
  )

  const saveDescriptionValue = useCallback(
    (value: string) => {
      updateDescriptionDraft(value)
      void saveField('description', value)
    },
    [saveField, updateDescriptionDraft]
  )

  const handleTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        event.currentTarget.blur()
        return
      }
      handleDescriptionKeyDown(event)
    },
    [handleDescriptionKeyDown]
  )

  const titleClass =
    density === 'page'
      ? 'text-[28px] font-semibold leading-tight'
      : 'text-[15px] font-semibold leading-tight'
  return (
    <div className="min-w-0">
      {fields !== 'description' ? (
        <div className="relative">
          <textarea
            ref={titleRef}
            value={titleDraft}
            onChange={(event) => updateTitleDraft(event.target.value)}
            onBlur={() => void saveField('title')}
            onKeyDown={handleTitleKeyDown}
            disabled={savingField === 'title'}
            rows={1}
            aria-label={translate(
              'auto.components.LinearIssueTextEditor.04d73b72dc',
              'Issue title'
            )}
            className={cn(
              'peer scrollbar-sleek block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1 py-0 text-foreground outline-none transition hover:border-border/50 hover:bg-accent/40 focus-visible:border-border focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-80',
              titleClass
            )}
          />
          <div className="pointer-events-none absolute bottom-1.5 right-2 z-10 flex items-center gap-1 text-[10px] text-muted-foreground/75 opacity-0 transition-opacity peer-focus:opacity-100">
            <kbd className="inline-flex h-4 min-w-4 select-none items-center justify-center rounded border border-border bg-muted/70 px-1 font-mono text-[9px] font-medium shadow-xs">
              ↵
            </kbd>
            <span>{translate('auto.components.LinearIssueTextEditor.947ba2d6f4', 'to save')}</span>
          </div>
          {savingField === 'title' ? (
            <LoaderCircle className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>
      ) : null}

      {fields !== 'title' ? (
        <div className="relative">
          <LinearIssueMarkdownDescriptionEditor
            value={descriptionDraft}
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
