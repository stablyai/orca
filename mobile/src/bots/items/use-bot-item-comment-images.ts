// Photos on an item's comment, as the desktop's comment box takes them: each uploads to the item's chat
// on the bot's host and gets an [Image #N] in the words, numbered as the thumbnails are. They stay with
// the item's draft for the app session, so a step or Back loses none, and an upload in flight lands.
import { useSyncExternalStore } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../../src/shared/clipboard/clipboard-image'
import { detectImageFileSignature } from '../../../../src/shared/file-content/image-file-signature'
import { imageReferenceInsertion } from '../../../../src/shared/native-chat/attachments/native-chat-image-reference'
import { queuedEditTextForKeptImages } from '../../../../src/shared/native-chat/input/queued-messages/queued-message-edit'
import { imageReferencesToPromptMarkers } from '../../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { uploadMobileAgentSessionAttachment } from '../../files/attachments/mobile-agent-session-attachment-upload'
import { fitMobileAgentImage } from '../../files/attachments/mobile-agent-image-fit'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMediaPicker } from '../../platform/media-picking/media-picker'
import {
  ImageLibraryPermissionError,
  type PickedMobileImage
} from '../../platform/media-picking/media-picker-contract'
import type { PendingNativeChatImage } from '../../session/native-chat/composer/attachments/mobile-native-chat-image-attachment'
import { decodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'

/** `path` is empty while it uploads. */
export type BotItemCommentImage = PendingNativeChatImage

const NONE: readonly BotItemCommentImage[] = []
const byItem = new Map<string, readonly BotItemCommentImage[]>()
// Photo picks still running per item: the picker reads each photo before it shows, so Send waits for them.
const picking = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
let added = 0

function read(uid: string): readonly BotItemCommentImage[] {
  return byItem.get(uid) ?? NONE
}

function change(
  uid: string,
  next: (images: readonly BotItemCommentImage[]) => readonly BotItemCommentImage[]
): void {
  const images = next(read(uid))
  if (images.length === 0) {
    byItem.delete(uid)
  } else {
    byItem.set(uid, images)
  }
  listeners.get(uid)?.forEach((listener) => listener())
}

function pick(uid: string, by: 1 | -1): void {
  const count = (picking.get(uid) ?? 0) + by
  if (count > 0) {
    picking.set(uid, count)
  } else {
    picking.delete(uid)
  }
  listeners.get(uid)?.forEach((listener) => listener())
}

function subscribe(uid: string, listener: () => void): () => void {
  const set = listeners.get(uid) ?? new Set()
  set.add(listener)
  listeners.set(uid, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(uid)
    }
  }
}

/** Named and previewed by its bytes: the host takes only image names it reads as images. */
function imageFormat(base64: string): { extension: string; mimeType: string } {
  return (
    detectImageFileSignature(decodeBase64Bytes(base64.slice(0, 16))) ?? {
      extension: 'png',
      mimeType: 'image/png'
    }
  )
}

export function useBotItemCommentImages({
  client,
  uid,
  sessionId,
  editText,
  showToast
}: {
  client: RpcClient | null
  uid: string
  /** The item's chat, which owns the uploads; null when its comments take no images. */
  sessionId: string | null
  /** Changes the item's draft, even after its box closed. */
  editText: (change: (text: string) => string) => void
  showToast: (message: string) => void
}) {
  const t = useMobileTranslation()
  const picker = useMediaPicker()
  const images = useSyncExternalStore(
    (listener) => subscribe(uid, listener),
    () => read(uid)
  )
  const picks = useSyncExternalStore(
    (listener) => subscribe(uid, listener),
    () => picking.get(uid) ?? 0
  )
  const ids = () => read(uid).map(({ id }) => id)

  const remove = (id: string): void => {
    const before = ids()
    change(uid, (current) => current.filter((image) => image.id !== id))
    // Its [Image #N] goes with it, and the later ones count down.
    editText((text) => queuedEditTextForKeptImages(text, before, ids()))
  }

  const upload = async (
    target: RpcClient,
    session: string,
    id: string,
    picked: PickedMobileImage
  ) => {
    const fitted = await fitMobileAgentImage(picked)
    const format = imageFormat(fitted.base64)
    const { path } = await uploadMobileAgentSessionAttachment(target, {
      sessionId: session,
      name: `image.${format.extension}`,
      base64: fitted.base64
    })
    // The fitted copy previews too, so the picked original's bytes aren't kept with the draft.
    const previewUri = picked.uri ?? `data:${format.mimeType};base64,${fitted.base64}`
    change(uid, (current) =>
      current.map((image) => (image.id === id ? { ...image, path, previewUri } : image))
    )
  }

  const attach = async (): Promise<void> => {
    if (!client || !sessionId) {
      return
    }
    pick(uid, 1)
    try {
      for await (const picked of picker.pickImages('library')) {
        added += 1
        const id = `comment-image-${added}`
        const previewUri = picked.uri ?? `data:image/png;base64,${picked.base64}`
        change(uid, (current) => [...current, { id, path: '', previewUri }])
        const all = ids()
        editText(
          (text) =>
            text + imageReferencesToPromptMarkers(imageReferenceInsertion(text, '', [id]), all)
        )
        await upload(client, sessionId, id, picked).catch((error: unknown) => {
          if (!ids().includes(id)) {
            return
          }
          remove(id)
          showToast(
            error instanceof Error && error.message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR
              ? t('chat.useImageUpload.imageTooLarge', 'Image too large to attach')
              : t('chat.useImageUpload.attachFailed', 'Attach failed')
          )
        })
      }
    } catch (error) {
      showToast(
        error instanceof ImageLibraryPermissionError
          ? t('chat.useImageUpload.permissionDenied', 'Photo permission denied')
          : t('chat.useImageUpload.attachFailed', 'Attach failed')
      )
    } finally {
      pick(uid, -1)
    }
  }

  return {
    images,
    uploading: picks > 0 || images.some((image) => !image.path),
    attach,
    remove,
    /** Sent: the thumbnails go; the words were taken with them. */
    clear: () => change(uid, () => NONE)
  }
}
