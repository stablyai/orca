import { useEffect, useRef } from 'react'
import { formatNativeChatFileReference } from '../../../src/shared/agent-image-paste'
import { translate } from '../i18n/mobile-i18n'
import { useMediaPicker } from '../platform/media-picker'
import type {
  PickedMobileFile,
  PickedMobileImage,
  SharedMobileContent
} from '../platform/media-picker-contract'

export type IncomingShareClaimTarget = {
  // A chat composer for the open tab is on screen.
  readonly composerVisible: boolean
  // Uploads can start now, so attachments are not dropped while the session connects.
  readonly canAttach: boolean
  readonly acceptsImages: boolean
  readonly appendText: (text: string) => boolean
  readonly attachImages: (picked: AsyncIterable<PickedMobileImage>) => Promise<void>
  // Writes a document into the workspace and resolves its workspace-relative path.
  readonly saveDocument: (file: PickedMobileFile) => Promise<string>
  readonly showToast: (message: string) => void
}

// Documents live in the project, so the agent and later sessions find them by a stable path.
async function saveSharedDocuments(
  files: AsyncIterable<PickedMobileFile>,
  target: IncomingShareClaimTarget
): Promise<void> {
  try {
    for await (const file of files) {
      try {
        target.appendText(formatNativeChatFileReference(await target.saveDocument(file)))
      } catch {
        target.showToast(
          translate('share.claim.saveFailed', "Couldn't save {{name}} to the workspace", {
            name: file.name
          })
        )
      }
    }
  } catch (error) {
    target.showToast(error instanceof Error ? error.message : String(error))
  }
}

// Shared content lands as an ordinary unsent draft through the composer's own text and upload paths.
function applyIncomingShare(share: SharedMobileContent, target: IncomingShareClaimTarget): void {
  if (share.text.length > 0) {
    target.appendText(share.text)
  }
  if (share.images) {
    void target.attachImages(share.images)
  }
  if (share.files) {
    void saveSharedDocuments(share.files, target)
  }
  if (share.skipped > 0) {
    target.showToast(
      translate('share.claim.unsupportedFiles', "This session can't take some of the shared files")
    )
  }
}

// A chat composer that opens ready takes the pending share once. One already open when a share
// arrives does not ask again; Home opens instead so the user picks where it goes.
export function useMobileIncomingShareClaim(target: IncomingShareClaimTarget): void {
  const { takeShare } = useMediaPicker()
  const targetRef = useRef(target)
  targetRef.current = target
  const ready = target.composerVisible && target.canAttach
  useEffect(() => {
    if (!ready) {
      return
    }
    void takeShare({ images: targetRef.current.acceptsImages, files: true })
      .then((share) => {
        if (share) {
          applyIncomingShare(share, targetRef.current)
        }
      })
      .catch(() => {
        targetRef.current.showToast(translate('chat.useImageUpload.attachFailed', 'Attach failed'))
      })
  }, [ready, takeShare])
}
