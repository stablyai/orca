import type { SessionOptionDescriptor } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  sayNativeChatSessionOptionEnglish as say,
  selectedNativeChatChoice
} from '../../../../../src/shared/native-chat-session-option-labels'

/** The value a drill-in row shows beside its label; desktop lists the choices in place instead. */
export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  // Show the boolean value consistently with its switch; the source marker separately expresses whether it is confirmed.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue ? 'On' : 'Off'
  }
  if (descriptor.valueSource === 'unknown') {
    return descriptor.id === 'permissionMode' ? 'Permissions' : 'Not set'
  }
  const choice = selectedNativeChatChoice(descriptor)
  if (!choice) {
    return 'Not set'
  }
  if (descriptor.id === 'permissionMode' && descriptor.description) {
    return descriptor.description
  }
  return nativeChatSessionChoiceLabel(choice, say, descriptor.id)
}
