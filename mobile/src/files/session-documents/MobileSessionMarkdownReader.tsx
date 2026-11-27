import { useState } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { MobileRichMarkdownEditor } from '../../components/rich-markdown/MobileRichMarkdownEditor'
import { markdownReaderStatusText } from './mobile-markdown-reader-status'
import type { MobilePalette } from '../../theme/mobile-theme'
import { useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import type { SupportedUiLocale } from '../../../../src/shared/i18n/ui-locale'
import { stylesSheet } from '../../session/mobile-session-styles'
import type { MarkdownDocState } from './session-document-state'
import { MobileLoadErrorState, MobileStateView } from '../../components/feedback/MobileStateView'
import { Presence } from '../../components/motion/AutoHeight'
import {
  useDocumentEditDraft,
  type DocumentEditDraftOffer
} from '../../drafts/use-document-edit-draft'
import { documentEditDraftOfferText } from '../../drafts/DocumentEditDraftOfferBar'
import { MobileMarkdownNoteBar, type MobileMarkdownNoteBarProps } from './MobileMarkdownNoteBar'

type ReadyMarkdownDoc = Extract<MarkdownDocState, { status: 'ready' }>

// Nothing floats over the note: its next step waits at the foot while the keyboard is down.
export function MarkdownReader({
  documentId,
  draftKey,
  doc,
  onRefresh,
  onChange,
  onSave,
  onCopy,
  onDiscard,
  loadImageSource,
  keyboardLift
}: {
  documentId: string
  draftKey: string
  doc: MarkdownDocState | undefined
  onRefresh: () => void
  onChange: (content: string) => void
  onSave: () => void
  onCopy: (text: string) => void
  onDiscard: () => void
  loadImageSource?: (path: string) => Promise<string>
  /** The session's keyboard lift, which leaves out the safe area under the content. */
  keyboardLift: number
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const locale = useMobileUiLocale()
  const intlLocale = intlLocaleFor(locale)
  const insets = useSafeAreaInsets()
  const [editing, setEditing] = useState(false)
  const ready = doc?.status === 'ready' ? doc : null
  const editDraft = useDocumentEditDraft({
    draftKey,
    base: ready?.content ?? null,
    editable: ready?.editable === true,
    live: ready?.localContent ?? '',
    onRestore: onChange
  })
  if (!doc || doc.status === 'loading') {
    return (
      <MobileStateView loading title={t('session.markdownReader.loading', 'Loading document…')} />
    )
  }
  if (doc.status === 'error') {
    return <MobileLoadErrorState error={doc.message} onRetry={onRefresh} />
  }

  const bar = editDraft.offer
    ? offerBar(editDraft.offer, t, intlLocale, colors, {
        onDiscard: editDraft.discardOffer,
        onRestore: editDraft.restore,
        onCopy: () => onCopy(editDraft.offer?.content ?? '')
      })
    : noteBar(doc, t, locale, colors, { onSave, onDiscard, onRefresh })

  return (
    <View style={styles.markdownEditor}>
      <MobileRichMarkdownEditor
        key={documentId}
        content={doc.localContent}
        editable={doc.editable && !doc.saving}
        onChange={onChange}
        loadImageSource={loadImageSource}
        // Same sum as the terminal dock: the lift plus the safe area it leaves out.
        formatRowBottom={keyboardLift + insets.bottom}
        onEditingChange={setEditing}
      />
      <Presence>{bar && !editing ? <MobileMarkdownNoteBar {...bar} /> : null}</Presence>
    </View>
  )
}

function noteBar(
  doc: ReadyMarkdownDoc,
  t: Translate,
  locale: SupportedUiLocale,
  colors: MobilePalette,
  actions: { onSave: () => void; onDiscard: () => void; onRefresh: () => void }
): MobileMarkdownNoteBarProps | null {
  const status = markdownReaderStatusText(doc, t, locale)
  const reason = status
    ? { text: status, color: doc.saveError ? colors.statusRed : undefined }
    : undefined
  if (doc.isDirty || doc.saving) {
    return {
      reason,
      quiet: {
        label: t('session.markdownReader.discard', 'Discard'),
        disabled: doc.saving,
        onPress: actions.onDiscard
      },
      primary: {
        label: t('common.save', 'Save'),
        pending: doc.saving,
        disabled: !doc.editable,
        onPress: actions.onSave
      }
    }
  }
  if (!reason) {
    return null
  }
  // Only a desktop change has a next step here; read-only and truncated notes just say so.
  return doc.stale
    ? {
        reason,
        primary: {
          label: t('common.refresh', 'Refresh'),
          secondary: true,
          onPress: actions.onRefresh
        }
      }
    : { reason }
}

function offerBar(
  offer: DocumentEditDraftOffer,
  t: Translate,
  intlLocale: string,
  colors: MobilePalette,
  actions: { onDiscard: () => void; onRestore: () => void; onCopy: () => void }
): MobileMarkdownNoteBarProps {
  return {
    reason: {
      text: documentEditDraftOfferText(offer, t, intlLocale),
      color: offer.baseMatches ? undefined : colors.statusAmber
    },
    quiet: { label: t('files.unsavedEditsOffer.discard', 'Discard'), onPress: actions.onDiscard },
    primary: offer.baseMatches
      ? { label: t('files.unsavedEditsOffer.restore', 'Restore'), onPress: actions.onRestore }
      : {
          label: t('files.unsavedEditsOffer.copyMyEdits', 'Copy My Edits'),
          onPress: actions.onCopy
        }
  }
}
