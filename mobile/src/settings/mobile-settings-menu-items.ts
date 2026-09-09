import { Bell, Globe, Info, MessageSquare, Mic, Terminal, Wrench } from 'lucide-react-native'
import type { MobileSettingsMenuItem } from './mobile-settings-menu'

// A caller without shell or page-preference capability disables the rows that need it.
export type MobileSettingsMenuAvailability = {
  shell?: boolean
  pagePreferences?: boolean
}

export function mobileSettingsMenuItems(
  push: (route: string) => void,
  availability: MobileSettingsMenuAvailability = {}
): MobileSettingsMenuItem[] {
  const shell = availability.shell ?? true
  const preferences = availability.pagePreferences ?? true
  return [
    {
      label: 'Terminal',
      icon: Terminal,
      disabled: !shell,
      onPress: () => push('/terminal-settings')
    },
    {
      label: 'Chat UI',
      icon: MessageSquare,
      disabled: !preferences,
      onPress: () => push('/native-chat-settings')
    },
    {
      label: 'Browser',
      icon: Globe,
      disabled: !preferences,
      onPress: () => push('/browser-settings')
    },
    { label: 'Voice', icon: Mic, disabled: !shell, onPress: () => push('/voice-settings') },
    { label: 'Notifications', icon: Bell, disabled: !shell, onPress: () => push('/notifications') },
    {
      label: 'Troubleshooting',
      icon: Wrench,
      disabled: !shell,
      onPress: () => push('/troubleshoot')
    },
    { label: 'About', icon: Info, onPress: () => push('/about') }
  ]
}
