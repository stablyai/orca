import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { FileWriteDiskConflict } from '../../../../src/shared/file-write/file-write-disk-precondition'
import { translate } from '../../i18n/mobile-i18n'
import { editorTextOfFileText, fileTextOfEditorText } from './mobile-file-preview-line-endings'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import {
  saveMobileTerminalArtifactPreview,
  type MobileFilePreviewSource
} from './mobile-file-preview-request'
import { saveErrorMessageFromPreviewResult } from './mobile-file-preview-response'
import {
  readMobileWorktreeFileBaseline,
  saveMobileWorktreeFile,
  type MobileWorktreeFileSaveResult
} from './mobile-worktree-file-save'

export type MobileFilePreviewConflict = Exclude<FileWriteDiskConflict, 'not-utf8'>

type SaveTarget = {
  client: MobileFilePreviewRpcSender | null
  source: MobileFilePreviewSource | null
  /** The editor is open on a loaded draft. */
  canWrite: boolean
  onSourceRefreshed: (source: MobileFilePreviewSource) => void
  /** Runs with the file text a save wrote, and whether the editor still shows what was saved. */
  onSaved: (fileText: string, draftUnchanged: boolean) => void
}

/**
 * The preview's edit text and its saves. Draft and saved text are the editor's (LF only);
 * `savedFileText` is the file's own, which saves compare disk against.
 */
export function useMobileFilePreviewSave(target: SaveTarget) {
  const [draftContent, setDraftState] = useState('')
  const [savedContent, setSavedState] = useState('')
  const [savedFileText, setSavedFileText] = useState('')
  const [conflict, setConflict] = useState<MobileFilePreviewConflict | null>(null)
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const saveRevisionRef = useRef(0)
  // Written with the state, so a save finishing before the next render compares against the latest draft.
  const draftContentRef = useRef(draftContent)
  const savedContentRef = useRef(savedContent)
  const setDraftContent = useCallback((content: string) => {
    draftContentRef.current = content
    setDraftState(content)
  }, [])
  const setSavedContent = useCallback((content: string) => {
    savedContentRef.current = content
    setSavedState(content)
  }, [])
  // Unmount retires pending saves.
  useLayoutEffect(
    () => () => {
      saveRevisionRef.current += 1
    },
    []
  )

  const acceptLoaded = useCallback(
    (fileText: string) => {
      const editorText = editorTextOfFileText(fileText)
      setDraftContent(editorText)
      setSavedContent(editorText)
      setSavedFileText(fileText)
      setConflict(null)
    },
    [setDraftContent, setSavedContent]
  )

  /** Drops the draft back to the saved text, for a reload that replaces both. */
  const revertDraft = useCallback(() => {
    setDraftContent(savedContentRef.current)
    setConflict(null)
  }, [setDraftContent])

  const { client, source, canWrite, onSourceRefreshed, onSaved } = target
  const save = useCallback(
    async (mode: 'save' | 'overwrite') => {
      const draft = draftContent
      if (
        !client ||
        !source ||
        !canWrite ||
        savingRef.current ||
        (mode === 'save' && draft === savedContent)
      ) {
        return
      }
      savingRef.current = true
      const saveRevision = ++saveRevisionRef.current
      const isCurrentSave = () => saveRevisionRef.current === saveRevision
      setSaving(true)
      setSaveError('')
      const fileText = fileTextOfEditorText(draft, savedFileText)
      try {
        let outcome: MobileWorktreeFileSaveResult
        if (source.source === 'terminalArtifact') {
          const result = await saveMobileTerminalArtifactPreview(client, source, fileText, {
            baseContent: savedFileText,
            isCurrent: isCurrentSave,
            onTerminalArtifactSourceRefreshed: (refreshed) => {
              if (isCurrentSave()) {
                onSourceRefreshed(refreshed)
              }
            }
          })
          outcome =
            result.status === 'saved'
              ? result
              : { status: 'error', message: saveErrorMessageFromPreviewResult(result) }
        } else if (mode === 'overwrite' && conflict === 'changed') {
          // Why re-read: the write still refuses a change made after the one being overwritten.
          const current = await readMobileWorktreeFileBaseline(client, source)
          if (!isCurrentSave()) {
            return
          }
          outcome =
            current.status === 'ok'
              ? await saveMobileWorktreeFile(client, source, fileText, current.fileText)
              : current.status === 'missing'
                ? await saveMobileWorktreeFile(client, source, fileText, savedFileText, {
                    allowMissing: true
                  })
                : current
        } else {
          outcome = await saveMobileWorktreeFile(client, source, fileText, savedFileText, {
            allowMissing: mode === 'overwrite'
          })
        }
        if (!isCurrentSave()) {
          return
        }
        if (outcome.status === 'saved') {
          setSavedContent(draft)
          setSavedFileText(fileText)
          setConflict(null)
          onSaved(fileText, draftContentRef.current === draft)
        } else if (outcome.status === 'conflict' && outcome.conflict !== 'not-utf8') {
          setConflict(outcome.conflict)
        } else {
          setSaveError(
            outcome.status === 'error'
              ? outcome.message
              : translate('files.filePreviewScreen.saveFailed', 'Unable to save file')
          )
        }
      } catch (err) {
        if (isCurrentSave()) {
          setSaveError(saveFailureMessage(err))
        }
      } finally {
        if (isCurrentSave()) {
          savingRef.current = false
          setSaving(false)
        }
      }
    },
    [
      canWrite,
      client,
      conflict,
      draftContent,
      onSaved,
      onSourceRefreshed,
      savedContent,
      savedFileText,
      setSavedContent,
      source
    ]
  )

  return {
    draftContent,
    setDraftContent,
    savedContent,
    draftContentRef,
    savedContentRef,
    conflict,
    saveError,
    setSaveError,
    saving,
    acceptLoaded,
    revertDraft,
    save
  }
}

function saveFailureMessage(err: unknown): string {
  // Why: the page's bridge refuses a request past its frame cap before anything reaches the host.
  if (err instanceof Error && 'code' in err && err.code === 'bridge_request_oversized') {
    return translate('files.filePreviewScreen.tooLargeToSave', 'Too large to save from your phone')
  }
  return err instanceof Error
    ? err.message
    : translate('files.filePreviewScreen.saveFailed', 'Unable to save file')
}
