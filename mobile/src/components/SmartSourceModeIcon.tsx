import { CaseSensitive, GitBranch, Sparkles } from 'lucide-react-native'
import type { SmartModeIcon } from '../tasks/mobile-smart-source-modes'
import { TaskProviderLogo } from './TaskProviderLogo'

// Renders a Smart-mode tab icon: the inline brand SVGs for provider modes,
// lucide glyphs for the neutral modes.
export function SmartSourceModeIcon({ icon, color }: { icon: SmartModeIcon; color: string }) {
  if (icon.type === 'provider') {
    return <TaskProviderLogo provider={icon.provider} size={14} color={color} />
  }
  if (icon.name === 'sparkles') {
    return <Sparkles size={14} color={color} />
  }
  if (icon.name === 'git-branch') {
    return <GitBranch size={14} color={color} />
  }
  return <CaseSensitive size={14} color={color} />
}
