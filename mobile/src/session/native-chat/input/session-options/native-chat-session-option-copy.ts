import type { NativeChatSessionOptionSay } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { translate, type Translate } from '../../../../i18n/mobile-i18n'

export function mobileNativeChatSessionOptionSay(t: Translate): NativeChatSessionOptionSay {
  return (id, values) => {
    switch (id) {
      case 'model':
        return t('chat.sessionOptionCopy.model', 'Model')
      case 'effort':
        return t('chat.sessionOptionCopy.effort', 'Effort')
      case 'fastMode':
        return t('chat.sessionOptionCopy.fastMode', 'Fast mode')
      case 'speed':
        return t('chat.sessionOptionCopy.speed', 'Speed')
      case 'thinking':
        return t('chat.sessionOptionCopy.thinking', 'Thinking')
      case 'standard':
        return t('chat.sessionOptionCopy.standard', 'Standard')
      case 'none':
        return t('chat.sessionOptionCopy.none', 'None')
      case 'off':
        return t('chat.sessionOptionCopy.off', 'Off')
      case 'minimal':
        return t('chat.sessionOptionCopy.minimal', 'Minimal')
      case 'low':
        return t('chat.sessionOptionCopy.low', 'Low')
      case 'medium':
        return t('chat.sessionOptionCopy.medium', 'Medium')
      case 'high':
        return t('chat.sessionOptionCopy.high', 'High')
      case 'xhigh':
        return t('chat.sessionOptionCopy.xhigh', 'Extra high')
      case 'max':
        return t('chat.sessionOptionCopy.max', 'Max')
      case 'ultracode':
        return t('chat.sessionOptionCopy.ultracode', 'Ultracode')
      case 'ultra':
        return t('chat.sessionOptionCopy.ultra', 'Ultra')
      case 'minimalShort':
        return t('chat.sessionOptionCopy.minimalShort', 'Min')
      case 'mediumShort':
        return t('chat.sessionOptionCopy.mediumShort', 'Med')
      case 'xhighShort':
        return t('chat.sessionOptionCopy.xhighShort', 'XHigh')
      case 'fast':
        return t('chat.sessionOptionCopy.fast', 'Fast')
      case 'toggleOption':
        return t('chat.sessionOptionCopy.toggleOption', 'Toggle {{value0}}', values)
      case 'chooseInAgentPicker':
        return t('chat.sessionOptionCopy.chooseInAgentPicker', 'Choose in agent picker…')
      case 'setWhenSessionStarts':
        return t('chat.sessionOptionCopy.setWhenSessionStarts', 'Set when the session starts.')
      case 'availableAfterSessionStarts':
        return t(
          'chat.sessionOptionCopy.availableAfterSessionStarts',
          'Available after the session starts.'
        )
      case 'modelsLoading':
        return t('chat.sessionOptionCopy.modelsLoading', 'Loading models…')
      case 'signInForModels':
        return t('chat.sessionOptionCopy.signInForModels', 'Sign in to see the models you can use.')
      case 'sessionOptions':
        return t('chat.sessionOptionCopy.sessionOptions', 'Session options')
    }
  }
}

export const sayMobileNativeChatSessionOption: NativeChatSessionOptionSay =
  mobileNativeChatSessionOptionSay(translate)
