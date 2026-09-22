import { Bell, Globe, Info, MessageSquare, Mic, Terminal, Wrench } from 'lucide-react-native'
import type { MobileSettingsMenuItem } from './mobile-settings-menu'

export function mobileSettingsMenuItems(push: (route: string) => void): MobileSettingsMenuItem[] {
  return [
    { label: 'Terminal', icon: Terminal, onPress: () => push('/terminal-settings') },
    { label: 'Chat UI', icon: MessageSquare, onPress: () => push('/native-chat-settings') },
    { label: 'Browser', icon: Globe, onPress: () => push('/browser-settings') },
    { label: 'Voice', icon: Mic, onPress: () => push('/voice-settings') },
    { label: 'Notifications', icon: Bell, onPress: () => push('/notifications') },
    { label: 'Troubleshooting', icon: Wrench, onPress: () => push('/troubleshoot') },
    { label: 'About', icon: Info, onPress: () => push('/about') }
  ]
}
