import { useRef, useState } from 'react'
import { Save, Trash2 } from 'lucide-react-native'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { DirtyMarkdownDraft } from '../files/session-documents/session-document-state'
import type { MobileSessionTab } from './tabs/mobile-session-tabs'
import type { MobileSessionController } from './use-mobile-session-controller'

type MarkdownTab = Extract<MobileSessionTab, { type: 'markdown' }>

/** Leaving with unsaved notes: Save, Don't save or Cancel, and nothing is lost unless you say so. */
export function MobileSessionLeaveDraftsSheet({
  controller
}: {
  controller: MobileSessionController
}) {
  const t = useMobileTranslation()
  const {
    leaveDrafts,
    setLeaveDrafts,
    leaveSession,
    leaveSessionDroppingDrafts,
    saveMarkdownTab,
    sessionTabs,
    showToast
  } = controller
  const [saving, setSaving] = useState(false)
  // Bumped on every close, so a save that settles after Cancel neither leaves nor reopens anything.
  const attemptRef = useRef(0)
  const drafts = leaveDrafts ?? []
  const single = drafts.length === 1 ? drafts[0] : null

  // Leave only once every note saved; a failure keeps you here with its error on the note.
  const saveAndLeave = async (pending: readonly DirtyMarkdownDraft[]) => {
    const attempt = attemptRef.current
    const saved = await Promise.all(
      pending.map((draft) => {
        const tab = sessionTabs.find(
          (candidate): candidate is MarkdownTab =>
            candidate.type === 'markdown' && candidate.id === draft.tabId
        )
        return tab ? saveMarkdownTab(tab) : Promise.resolve(false)
      })
    )
    if (attempt !== attemptRef.current) {
      return
    }
    setSaving(false)
    setLeaveDrafts(null)
    if (saved.every(Boolean)) {
      leaveSession()
      return
    }
    const failed = pending.filter((_, index) => !saved[index])
    showToast(
      failed.length === 1
        ? t('session.useMarkdownActions.saveNoteFailed', "Couldn't save {{name}}", {
            name: failed[0].title
          })
        : t('session.useMarkdownActions.saveNotesFailed', "Couldn't save {{count}} notes", {
            count: failed.length
          }),
      2000
    )
  }

  return (
    <ActionSheetModal
      visible={leaveDrafts != null}
      title={
        single
          ? t('session.sheets.saveChangesTo', 'Save changes to {{name}}?', { name: single.title })
          : t('session.sheets.saveChangesToNotes', 'Save changes to {{count}} notes?', {
              count: drafts.length
            })
      }
      message={t('session.sheets.editsOnPhone', 'Your edits are only on this phone.')}
      actions={[
        {
          id: 'save',
          label: single ? t('common.save', 'Save') : t('session.sheets.saveAll', 'Save all'),
          icon: Save,
          loading: saving,
          // Stays open on its spinner until every save settles.
          skipAutoClose: true,
          onPress: () => {
            setSaving(true)
            void saveAndLeave(drafts)
          }
        },
        {
          id: 'dontSave',
          label: t('session.sheets.dontSave', 'Don’t save'),
          icon: Trash2,
          destructive: true,
          disabled: saving,
          onPress: () => {
            setLeaveDrafts(null)
            leaveSessionDroppingDrafts(drafts)
          }
        }
      ]}
      cancelLabel={t('common.cancel', 'Cancel')}
      onClose={() => {
        attemptRef.current += 1
        setSaving(false)
        setLeaveDrafts(null)
      }}
    />
  )
}
