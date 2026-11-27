import {
  Bell,
  Globe,
  Info,
  LifeBuoy,
  MessageSquare,
  Mic,
  Shield,
  SunMoon,
  Terminal,
  Wrench
} from 'lucide-react-native'
import type { MobileSettingsMenuItem } from './mobile-settings-menu'
import { translate } from '../i18n/mobile-i18n'

/** Settings' rows in three groups: how the app looks and sounds, its surfaces, then help. */
export function mobileSettingsMenuGroups({
  push,
  openExternal,
  appearanceValue,
  aboutValue
}: {
  push: (route: string) => void
  openExternal: (url: string) => void
  appearanceValue?: string
  aboutValue?: string
}): [MobileSettingsMenuItem[], MobileSettingsMenuItem[], MobileSettingsMenuItem[]] {
  return [
    [
      {
        id: 'appearance',
        label: translate('settings.menuItems.appearance', 'Appearance'),
        icon: SunMoon,
        value: appearanceValue,
        onPress: () => push('/appearance-settings')
      },
      {
        id: 'notifications',
        label: translate('settings.menuItems.notifications', 'Notifications'),
        icon: Bell,
        onPress: () => push('/notifications')
      },
      {
        id: 'voice',
        label: translate('settings.menuItems.voice', 'Voice'),
        icon: Mic,
        onPress: () => push('/voice-settings')
      }
    ],
    [
      {
        id: 'terminal',
        label: translate('settings.menuItems.terminal', 'Terminal'),
        icon: Terminal,
        onPress: () => push('/terminal-settings')
      },
      {
        id: 'nativeChat',
        label: translate('settings.menuItems.chat', 'Chat'),
        icon: MessageSquare,
        onPress: () => push('/native-chat-settings')
      },
      {
        id: 'browser',
        label: translate('settings.menuItems.browser', 'Browser'),
        icon: Globe,
        onPress: () => push('/browser-settings')
      }
    ],
    [
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
        value: aboutValue,
        onPress: () => push('/about')
      },
      {
        id: 'privacyPolicy',
        label: translate('settings.menuScreen.privacyPolicy', 'Privacy policy'),
        icon: Shield,
        external: true,
        onPress: () => openExternal('https://orca.dev/privacy')
      },
      {
        id: 'support',
        label: translate('settings.menuScreen.support', 'Support'),
        icon: LifeBuoy,
        external: true,
        onPress: () => openExternal('https://github.com/stablyai/orca/issues')
      }
    ]
  ]
}
