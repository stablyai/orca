import {
  nativeChatImageLabel,
  type NativeChatImageLabelCopy
} from '../../../../../../src/shared/native-chat/attachments/native-chat-image-label'
import type { NativeChatImageRefBlock } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { Translate } from '../../../../i18n/mobile-i18n'

/** What an image the phone can't draw is called: the desktop's label (its alt text, else its file's
 *  name), never the host path it was read from. */
export function mobileNativeChatImageLabel(block: NativeChatImageRefBlock, t: Translate): string {
  const copy: NativeChatImageLabelCopy = {
    pastedImage: t('chat.nativeChatProse.pastedImage', 'Pasted image'),
    imageCount: (count) => t('chat.nativeChatProse.imageCount', '{{count}} images', { count })
  }
  return nativeChatImageLabel(block, copy)
}
