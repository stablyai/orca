import { translate } from '../../../i18n/mobile-i18n'
import type { SessionOptionDescriptor } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../src/shared/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'

/** The value a drill-in row shows beside its label; desktop lists the choices in place instead. */
export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  // Show the boolean value consistently with its switch; the source marker separately expresses whether it is confirmed.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue
      ? translate('chat.sessionOptionCopy.on', 'On')
      : translate('chat.sessionOptionCopy.off', 'Off')
  }
  if (descriptor.valueSource === 'unknown') {
    return descriptor.id === 'permissionMode'
      ? translate('chat.sessionOptionCopy.permissions', 'Permissions')
      : translate('chat.sessionOptionCopy.notSet', 'Not set')
  }
  const choice = selectedNativeChatChoice(descriptor)
  if (!choice) {
    return translate('chat.sessionOptionCopy.notSet', 'Not set')
  }
  if (descriptor.id === 'permissionMode' && descriptor.description) {
    return descriptor.description
  }
  return nativeChatSessionChoiceLabel(choice, say, descriptor.id)
}
