import { CaseSensitive, GitBranch, Sparkles } from '../../../components/icons/app-icons'
import type { SmartModeIcon } from '../mobile-smart-source-modes'
import { TaskProviderLogo } from '../../../components/icons/TaskProviderLogo'

// Provider modes use brand SVGs; neutral modes use lucide glyphs.
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
