import type { PickedMobileFile } from '../../../../platform/media-picking/media-picker-contract'
import type { MobileNativeChatSendIntent } from '../delivery/mobile-native-chat-send'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileNativeChatImageSource } from './mobile-native-chat-composer-paste'

export type MobileNativeChatImageAttachments = {
  /** Pending chips for the active scope (tab) only. */
  readonly attachments: PendingNativeChatImage[]
  readonly isAttaching: boolean
  readonly attachImage: (source: MobileNativeChatImageSource) => Promise<void>
  readonly attachStreamedFiles: (
    files: AsyncIterable<PickedMobileFile> | readonly PickedMobileFile[]
  ) => Promise<void>
  readonly attachFiles: () => Promise<void>
  /** The gallery pick, which also takes videos; absent where the chat cannot stream them. */
  readonly attachGallery?: () => Promise<void>
  readonly removeAttachment: (id: string) => void
  /** Ride any pending images along with `text`, then submit; clears the sent
   *  chips (and only those) once the send is accepted. */
  readonly sendNativeChat: (text: string, intent?: MobileNativeChatSendIntent) => Promise<boolean>
}
