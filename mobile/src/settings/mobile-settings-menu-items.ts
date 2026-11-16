import {
  Bell,
  Globe,
  Info,
  MessageSquare,
  Mic,
  SunMoon,
  Terminal,
  Wrench
} from 'lucide-react-native'
import type { MobileSettingsMenuItem } from './mobile-settings-menu'
import { translate } from '../i18n/mobile-i18n'

export function mobileSettingsMenuItems(push: (route: string) => void): MobileSettingsMenuItem[] {
  return [
    {
      id: 'appearance',
      label: translate('settings.menuItems.appearance', 'Appearance'),
      icon: SunMoon,
      onPress: () => push('/appearance-settings')
    },
    {
      id: 'terminal',
      label: translate('settings.menuItems.terminal', 'Terminal'),
      icon: Terminal,
      onPress: () => push('/terminal-settings')
    },
    {
      id: 'nativeChat',
      label: translate('settings.menuItems.chatUi', 'Chat UI'),
      icon: MessageSquare,
      onPress: () => push('/native-chat-settings')
    },
    {
      id: 'browser',
      label: translate('settings.menuItems.browser', 'Browser'),
      icon: Globe,
      onPress: () => push('/browser-settings')
    },
    {
      id: 'voice',
      label: translate('settings.menuItems.voice', 'Voice'),
      icon: Mic,
      onPress: () => push('/voice-settings')
    },
    {
      id: 'notifications',
      label: translate('settings.menuItems.notifications', 'Notifications'),
      icon: Bell,
      onPress: () => push('/notifications')
    },
    {
      id: 'troubleshoot',
      label: translate('settings.menuItems.troubleshooting', 'Troubleshooting'),
      icon: Wrench,
      onPress: () => push('/troubleshoot')
    },
    {
      id: 'about',
      label: translate('settings.menuItems.about', 'About'),
      icon: Info,
      onPress: () => push('/about')
    }
  ]
}
