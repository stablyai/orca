import { fileEditDraftKey } from '../drafts/document-edit-draft-rows'
import { DocumentEditDraftOfferBar } from '../drafts/DocumentEditDraftOfferBar'
import { useDocumentEditDraft } from '../drafts/use-document-edit-draft'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { spacing } from '../theme/mobile-theme'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'

/** Only terminal artifacts are editable in the file preview. */
export function filePreviewEditDraftKey(source: MobileFilePreviewSource | null): string | null {
  return source?.source === 'terminalArtifact'
    ? fileEditDraftKey(source.worktreeId, source.absolutePath)
    : null
}

/** Keeps the preview's unsaved edits in the device store, and offers back the ones a kill left. */
export function MobileFilePreviewEditDraft(props: {
  draftKey: string | null
  base: string | null
  live: string
  onRestore: (content: string) => void
}) {
  const { offer, restore, discardOffer } = useDocumentEditDraft(props)
  const clipboard = useClipboardWriter()
  const insets = useSafeAreaInsets()
  return offer ? (
    <DocumentEditDraftOfferBar
      offer={offer}
      bottom={insets.bottom + spacing.lg}
      onDiscard={discardOffer}
      onRestore={restore}
      onCopy={() => void clipboard.writeText(offer.content).then(triggerSuccess, triggerError)}
    />
  ) : null
}
