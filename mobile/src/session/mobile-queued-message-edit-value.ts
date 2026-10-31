import type { MobileNativeChatDraftInputs } from './native-chat/composer/mobile-native-chat-draft-inputs'
import { pickedSkillsInText } from '../../../src/shared/structured-agent-session-send-mutation'

type Image = MobileNativeChatDraftInputs['images'][number]
export function sameMobileQueuedEditImage(left: Image, right: Image): boolean {
  return left.id === right.id && left.path === right.path && left.previewUri === right.previewUri
}
export function mobileQueuedEditValueKey(
  text: string,
  inputs: MobileNativeChatDraftInputs
): string {
  return JSON.stringify([
    text,
    pickedSkillsInText(text, inputs.skills, ['$', '/']),
    inputs.images,
    inputs.files,
    inputs.pending ?? 0
  ])
}

export function snapshotMobileQueuedEditInputs(
  inputs: MobileNativeChatDraftInputs
): MobileNativeChatDraftInputs {
  return {
    ...inputs,
    images: inputs.images.map((image) => ({ ...image })),
    files: inputs.files.map((file) => ({ ...file })),
    skills: inputs.skills.map((skill) => ({ ...skill }))
  }
}
