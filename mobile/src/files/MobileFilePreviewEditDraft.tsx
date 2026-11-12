import { fileEditDraftKey } from '../drafts/document-edit-draft-rows'
import { DocumentEditDraftOfferBar } from '../drafts/DocumentEditDraftOfferBar'
import {
  useDocumentEditDraft,
  type DocumentEditDraftOffer
} from '../drafts/use-document-edit-draft'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { spacing } from '../theme/mobile-theme'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'
import { resolveMarkdownFloatingActionsBottom } from './session-documents/markdown-floating-actions-layout'

/** Only terminal artifacts are editable in the file preview. */
export function filePreviewEditDraftKey(
  source: MobileFilePreviewSource | null,
  hostId: string | undefined,
  executionHost: string | undefined
): string | null {
  return source?.source === 'terminalArtifact' && hostId
    ? fileEditDraftKey(
        { hostId, executionHost, worktreeId: source.worktreeId },
        source.absolutePath
      )
    : null
}

/** Keeps the preview's unsaved edits in the device store, and offers back the ones a kill left. */
export function MobileFilePreviewEditDraft(props: {
  draftKey: string | null
  base: string | null
  editable: boolean
  live: string
  onRestore: (content: string) => void
}) {
  const { offer, restore, discardOffer } = useDocumentEditDraft(props)
  return offer ? <OfferBar offer={offer} onDiscard={discardOffer} onRestore={restore} /> : null
}

function OfferBar(props: {
  offer: DocumentEditDraftOffer
  onDiscard: () => void
  onRestore: () => void
}) {
  const clipboard = useClipboardWriter()
  const insets = useSafeAreaInsets()
  const keyboardHeight = useKeyboardOcclusion()
  return (
    <DocumentEditDraftOfferBar
      {...props}
      bottom={resolveMarkdownFloatingActionsBottom({
        keyboardLift: keyboardHeight,
        restingBottom: insets.bottom + spacing.lg,
        liftedClearance: spacing.md
      })}
      onCopy={() =>
        void clipboard.writeText(props.offer.content).then(triggerSuccess, triggerError)
      }
    />
  )
}
