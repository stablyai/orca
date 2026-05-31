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
  const [titleDraft, setTitleDraft] = useState(issue.title)
  const [descriptionDraft, setDescriptionDraft] = useState(issue.description ?? '')
  const [savingField, setSavingField] = useState<'title' | 'description' | null>(null)
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const titleRef = useAutosizeTextArea(titleDraft)
  const lastIssueIdRef = useRef(issue.id)
  const mountedRef = useMountedRef()
  const lastSyncedTitleRef = useRef(issue.title)
  const lastSyncedDescriptionRef = useRef(issue.description ?? '')

  useEffect(() => {
    const nextDescription = issue.description ?? ''
    if (issue.id !== lastIssueIdRef.current) {
      lastIssueIdRef.current = issue.id
      lastSyncedTitleRef.current = issue.title
      lastSyncedDescriptionRef.current = nextDescription
      setTitleDraft(issue.title)
      setDescriptionDraft(nextDescription)
      setSavingField(null)
      return
    }

    const previousTitle = lastSyncedTitleRef.current
    const previousDescription = lastSyncedDescriptionRef.current

    // Why: optimistic saves can update one field while the user has unsaved
    // edits in the other; only sync fields that still match the last source.
    if (issue.title !== previousTitle && titleDraft === previousTitle) {
      setTitleDraft(issue.title)
    }
    if (nextDescription !== previousDescription && descriptionDraft === previousDescription) {
      setDescriptionDraft(nextDescription)
    }

    lastSyncedTitleRef.current = issue.title
    lastSyncedDescriptionRef.current = nextDescription
  }, [descriptionDraft, issue.description, issue.id, issue.title, titleDraft])

  const saveField = useCallback(
    async (field: 'title' | 'description', descriptionOverride?: string) => {
      const nextTitle = titleDraft.trim()
      const nextDescription = (descriptionOverride ?? descriptionDraft).trimEnd()
      if (field === 'title' && !nextTitle) {
        setTitleDraft(issue.title)
        toast.error('Title is required')
        return
      }

      const nextValue = field === 'title' ? nextTitle : nextDescription
      const currentValue = field === 'title' ? issue.title : (issue.description ?? '')
      if (nextValue === currentValue) {
        return
      }

      const patch =
        field === 'title'
          ? ({ title: nextTitle } as const)
          : ({ description: nextDescription } as const)
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
            setTitleDraft(issue.title)
          } else {
            setDescriptionDraft(issue.description ?? '')
          }
        }
        toast.error(error instanceof Error ? error.message : `Failed to update ${field}`)
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
      titleDraft
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
      setDescriptionDraft(value)
      void saveField('description', value)
    },
    [saveField]
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
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => void saveField('title')}
            onKeyDown={handleTitleKeyDown}
            disabled={savingField === 'title'}
            rows={1}
            aria-label="Issue title"
            className={cn(
              'peer scrollbar-sleek block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1 py-0 text-foreground outline-none transition hover:border-border/50 hover:bg-accent/40 focus-visible:border-border focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-80',
              titleClass
            )}
          />
          <div className="pointer-events-none absolute bottom-1.5 right-2 z-10 flex items-center gap-1 text-[10px] text-muted-foreground/75 opacity-0 transition-opacity peer-focus:opacity-100">
            <kbd className="inline-flex h-4 min-w-4 select-none items-center justify-center rounded border border-border bg-muted/70 px-1 font-mono text-[9px] font-medium shadow-xs">
              ↵
            </kbd>
            <span>to save</span>
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
            onChange={setDescriptionDraft}
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
