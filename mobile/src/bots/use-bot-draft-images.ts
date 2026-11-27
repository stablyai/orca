// Photos on an item's comment or a group post, as the desktop's composers take them: each is shrunk,
// uploads to a chat on the host and gets an [Image #N] in the words, numbered as the thumbnails are.
// They stay with the draft for the app session, so a step or Back loses none, and an upload in flight lands.
import { useSyncExternalStore } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard/clipboard-image'
import { detectImageFileSignature } from '../../../src/shared/file-content/image-file-signature'
import { imageReferenceInsertion } from '../../../src/shared/native-chat/attachments/native-chat-image-reference'
import { queuedEditTextForKeptImages } from '../../../src/shared/native-chat/input/queued-messages/queued-message-edit'
import { imageReferencesToPromptMarkers } from '../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { uploadMobileAgentSessionAttachment } from '../files/attachments/mobile-agent-session-attachment-upload'
import { fitMobileAgentImage } from '../files/attachments/mobile-agent-image-fit'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMediaPicker } from '../platform/media-picking/media-picker'
import {
  ImageLibraryPermissionError,
  type PickedMobileImage
} from '../platform/media-picking/media-picker-contract'
import type { PendingNativeChatImage } from '../session/native-chat/composer/attachments/mobile-native-chat-image-attachment'
import {
  mobileNativeChatDraftDestination,
  readMobileNativeChatDraftInputs,
  type MobileNativeChatDraftDestination,
  updateMobileNativeChatDraftInputs,
  useMobileNativeChatDraftInputs
} from '../session/native-chat/composer/drafts/mobile-native-chat-draft-inputs'
import { decodeBase64Bytes } from '../transport/encryption/base64-byte-codec'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** `path` is empty while it uploads. */
export type BotDraftImage = PendingNativeChatImage

// Picks still running per draft: the picker reads each photo before it shows, so Send waits for them.
const picking = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()
let added = 0

// The images live with the draft's text in chat's draft store, which saves a chat-scoped draft's uploaded ones.
function read(draftKey: string): readonly BotDraftImage[] {
  return readMobileNativeChatDraftInputs(draftKey).images
}

function change(
  draft: string | MobileNativeChatDraftDestination,
  next: (images: readonly BotDraftImage[]) => readonly BotDraftImage[]
): void {
  updateMobileNativeChatDraftInputs(draft, (held) => ({ ...held, images: next(held.images) }))
}

function pick(draftKey: string, by: 1 | -1): void {
  const count = (picking.get(draftKey) ?? 0) + by
  if (count > 0) {
    picking.set(draftKey, count)
  } else {
    picking.delete(draftKey)
  }
  listeners.get(draftKey)?.forEach((listener) => listener())
}

function subscribe(draftKey: string, listener: () => void): () => void {
  const set = listeners.get(draftKey) ?? new Set()
  set.add(listener)
  listeners.set(draftKey, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) {
      listeners.delete(draftKey)
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

export function useBotDraftImages({
  client,
  draftKey,
  sessionId,
  editText,
  showToast,
  markersInText = true
}: {
  client: RpcClient | null
  draftKey: string
  /** The chat that owns the uploads; null when the draft takes no images. */
  sessionId: string | null
  /** Changes the draft, even after its box closed. */
  editText: (change: (text: string) => string) => void
  showToast: (message: string) => void
  /** False keeps the words free of [Image #N], as a chat's composer does; the photos ride in order. */
  markersInText?: boolean
}) {
  const t = useMobileTranslation()
  const picker = useMediaPicker()
  const images = useMobileNativeChatDraftInputs(draftKey, 'images')
  const picks = useSyncExternalStore(
    (listener) => subscribe(draftKey, listener),
    () => picking.get(draftKey) ?? 0
  )
  const ids = () => read(draftKey).map(({ id }) => id)

  const drop = (gone: readonly string[], inText: boolean): void => {
    const before = ids()
    change(draftKey, (current) => current.filter((image) => !gone.includes(image.id)))
    const after = ids()
    // Their [Image #N] go with them and the later ones count down; nothing to renumber when none are left of a send.
    if (markersInText && (inText || after.length > 0)) {
      editText((text) => queuedEditTextForKeptImages(text, before, after))
    }
  }
  const remove = (id: string): void => drop([id], true)

  const upload = async (
    target: RpcClient,
    session: string,
    draft: MobileNativeChatDraftDestination,
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
    change(draft, (current) =>
      current.map((image) => (image.id === id ? { ...image, path, previewUri } : image))
    )
  }

  const attach = async (): Promise<void> => {
    if (!client || !sessionId) {
      return
    }
    // A draft closed meanwhile (its group deleted) takes no late photo.
    const draft = mobileNativeChatDraftDestination(draftKey)
    pick(draftKey, 1)
    try {
      for await (const picked of picker.pickImages('library')) {
        if (!draft.active) {
          return
        }
        added += 1
        const id = `draft-image-${added}`
        const previewUri = picked.uri ?? `data:image/png;base64,${picked.base64}`
        change(draft, (current) => [...current, { id, path: '', previewUri }])
        const all = ids()
        if (markersInText) {
          editText(
            (text) =>
              text + imageReferencesToPromptMarkers(imageReferenceInsertion(text, '', [id]), all)
          )
        }
        await upload(client, sessionId, draft, id, picked).catch((error: unknown) => {
          if (!draft.active || !ids().includes(id)) {
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
      pick(draftKey, -1)
    }
  }

  return {
    images,
    uploading: picks > 0 || images.some((image) => !image.path),
    attach,
    remove,
    /** Sending: these thumbnails go with the words, at once, so a page closed mid-send can't bring them
     *  back; any picked since stay, renumbered. */
    clearSent: (sent: readonly string[]) => drop(sent, false),
    /** A refused send's thumbnails come back after any picked since, as its words do. */
    returnRefused: (sent: readonly BotDraftImage[]) =>
      change(draftKey, (current) => [...current, ...sent])
  }
}
