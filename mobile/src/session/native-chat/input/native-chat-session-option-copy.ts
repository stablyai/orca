import type { NativeChatSessionOptionSay } from '../../../../../src/shared/native-chat-session-option-labels'
import { translate } from '../../../i18n/mobile-i18n'

export const sayMobileNativeChatSessionOption: NativeChatSessionOptionSay = (id, values) => {
  switch (id) {
    case 'model':
      return translate('chat.sessionOptionCopy.model', 'Model')
    case 'effort':
      return translate('chat.sessionOptionCopy.effort', 'Effort')
    case 'fastMode':
      return translate('chat.sessionOptionCopy.fastMode', 'Fast mode')
    case 'speed':
      return translate('chat.sessionOptionCopy.speed', 'Speed')
    case 'thinking':
      return translate('chat.sessionOptionCopy.thinking', 'Thinking')
    case 'standard':
      return translate('chat.sessionOptionCopy.standard', 'Standard')
    case 'minimal':
      return translate('chat.sessionOptionCopy.minimal', 'Minimal')
    case 'low':
      return translate('chat.sessionOptionCopy.low', 'Low')
    case 'medium':
      return translate('chat.sessionOptionCopy.medium', 'Medium')
    case 'high':
      return translate('chat.sessionOptionCopy.high', 'High')
    case 'xhigh':
      return translate('chat.sessionOptionCopy.xhigh', 'Extra high')
    case 'max':
      return translate('chat.sessionOptionCopy.max', 'Max')
    case 'ultra':
      return translate('chat.sessionOptionCopy.ultra', 'Ultra')
    case 'minimalShort':
      return translate('chat.sessionOptionCopy.minimalShort', 'Min')
    case 'mediumShort':
      return translate('chat.sessionOptionCopy.mediumShort', 'Med')
    case 'xhighShort':
      return translate('chat.sessionOptionCopy.xhighShort', 'XHigh')
    case 'fast':
      return translate('chat.sessionOptionCopy.fast', 'Fast')
    case 'toggleOption':
      return translate('chat.sessionOptionCopy.toggleOption', 'Toggle {{value0}}', values)
    case 'chooseInAgentPicker':
      return translate('chat.sessionOptionCopy.chooseInAgentPicker', 'Choose in agent picker…')
    case 'setWhenSessionStarts':
      return translate(
        'chat.sessionOptionCopy.setWhenSessionStarts',
        'Set when the session starts.'
      )
    case 'availableAfterSessionStarts':
      return translate(
        'chat.sessionOptionCopy.availableAfterSessionStarts',
        'Available after the session starts.'
      )
    case 'sessionOptions':
      return translate('chat.sessionOptionCopy.sessionOptions', 'Session options')
  }
}
