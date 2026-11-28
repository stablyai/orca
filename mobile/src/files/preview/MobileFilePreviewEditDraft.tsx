import type { ReactNode } from 'react'
import { fileEditDraftKey } from '../../drafts/document-edit-draft-rows'
import { DocumentEditDraftOfferBar } from '../../drafts/DocumentEditDraftOfferBar'
import {
  useDocumentEditDraft,
  type DocumentEditDraftOffer
} from '../../drafts/use-document-edit-draft'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import { useKeyboardOcclusion } from '../../platform/keyboard/keyboard-occlusion'
import { spacing } from '../../theme/mobile-theme'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'
import { resolveMarkdownFloatingActionsBottom } from '../session-documents/markdown-floating-actions-layout'

/** Artifacts key by absolute path and workspace files by relative path, which can never collide. */
export function filePreviewEditDraftKey(
  source: MobileFilePreviewSource | null,
  hostId: string | undefined,
  executionHost: string | undefined
): string | null {
  if (!source || !hostId) {
    return null
  }
  return fileEditDraftKey(
    { hostId, executionHost, worktreeId: source.worktreeId },
    source.source === 'terminalArtifact' ? source.absolutePath : source.relativePath
  )
}

/** Keeps the preview's unsaved edits in the device store, and offers back the ones a kill left. */
export function MobileFilePreviewEditDraft(props: {
  draftKey: string | null
  base: string | null
  editable: boolean
  live: string
  onRestore: (content: string) => void
  /** The bar shown when there is no offer, which would sit in the same place. */
  fallback?: ReactNode
}) {
  const { offer, restore, discardOffer } = useDocumentEditDraft(props)
  return offer ? (
    <OfferBar offer={offer} onDiscard={discardOffer} onRestore={restore} />
  ) : (
    (props.fallback ?? null)
  )
}

/** Where the preview's floating bars sit: above the keyboard while it is up. */
export function useFilePreviewFloatingBarBottom(): number {
  const insets = useSafeAreaInsets()
  const keyboardHeight = useKeyboardOcclusion()
  return resolveMarkdownFloatingActionsBottom({
    keyboardLift: keyboardHeight,
    restingBottom: insets.bottom + spacing.lg,
    liftedClearance: spacing.md
  })
}

function OfferBar(props: {
  offer: DocumentEditDraftOffer
  onDiscard: () => void
  onRestore: () => void
}) {
  const clipboard = useClipboardWriter()
  return (
    <DocumentEditDraftOfferBar
      {...props}
      bottom={useFilePreviewFloatingBarBottom()}
      onCopy={() =>
        void clipboard.writeText(props.offer.content).then(triggerSuccess, triggerError)
      }
    />
  )
}
