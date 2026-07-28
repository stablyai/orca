import type { CSSProperties } from 'react'
import { getFileTypeIcon, getPluginFileTypeIconImage } from '@/lib/file-type-icons'
import { usePluginIconThemeStore } from '@/store/plugin-icon-themes'
import { PluginIconImage } from './PluginIconImage'

type FileTypeIconProps = {
  filePath: string | null | undefined
  className?: string
  style?: CSSProperties
}

export function FileTypeIcon({ filePath, className, style }: FileTypeIconProps): React.JSX.Element {
  const activeTheme = usePluginIconThemeStore((state) => state.activeTheme)
  const pluginIcon = getPluginFileTypeIconImage(activeTheme, filePath)
  if (pluginIcon) {
    return <PluginIconImage image={pluginIcon} className={className} style={style} />
  }
  const BuiltInIcon = getFileTypeIcon(filePath)
  return <BuiltInIcon aria-hidden="true" className={className} style={style} />
}
