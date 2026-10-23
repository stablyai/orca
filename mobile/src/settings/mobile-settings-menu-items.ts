import {
  Bell,
  Globe,
  Info,
  LifeBuoy,
  MessageSquare,
  Mic,
  Shield,
  Terminal,
  Wrench
} from 'lucide-react-native'
import type { MobileSettingsMenuItem } from './mobile-settings-menu'

export type MobileSettingsMenuGroup = { title: string; items: MobileSettingsMenuItem[] }

const PRIVACY_POLICY_URL = 'https://www.onorca.dev/privacy'
const SUPPORT_URL = 'https://github.com/stablyai/orca/issues'

export function mobileSettingsMenuGroups(
  push: (route: string) => void,
  openExternal: (url: string) => void
): {
  session: MobileSettingsMenuGroup
  alerts: MobileSettingsMenuGroup
  help: MobileSettingsMenuGroup
  about: MobileSettingsMenuGroup
} {
  return {
    session: {
      title: 'Session',
      items: [
        { label: 'Terminal', icon: Terminal, onPress: () => push('/terminal-settings') },
        { label: 'Chat UI', icon: MessageSquare, onPress: () => push('/native-chat-settings') },
        { label: 'Browser', icon: Globe, onPress: () => push('/browser-settings') },
        { label: 'Voice', icon: Mic, onPress: () => push('/voice-settings') }
      ]
    },
    alerts: {
      title: 'Alerts',
      items: [{ label: 'Notifications', icon: Bell, onPress: () => push('/notifications') }]
    },
    help: {
      title: 'Help',
      items: [
        { label: 'Troubleshooting', icon: Wrench, onPress: () => push('/troubleshoot') },
        {
          label: 'Support',
          icon: LifeBuoy,
          external: true,
          onPress: () => openExternal(SUPPORT_URL)
        }
      ]
    },
    about: {
      title: 'About',
      items: [
        { label: 'About Orca', icon: Info, onPress: () => push('/about') },
        {
          label: 'Privacy policy',
          icon: Shield,
          external: true,
          onPress: () => openExternal(PRIVACY_POLICY_URL)
        }
      ]
    }
  }
}
