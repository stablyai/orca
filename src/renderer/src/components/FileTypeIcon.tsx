import { createElement } from 'react'
import type { LucideProps } from 'lucide-react'
import { useAppStore } from '@/store'
import { getFileTypeIcon } from '@/lib/file-type-icons'
import { getFileTypeIconColor } from '@/lib/file-type-icon-colors'

type FileTypeIconProps = LucideProps & { filePath: string | undefined | null }

export function FileTypeIcon({ filePath, style, ...props }: FileTypeIconProps): React.JSX.Element {
  const colored = useAppStore((state) => state.settings?.coloredFileIcons === true)
  const icon = getFileTypeIcon(filePath)
  const color = colored ? getFileTypeIconColor(icon) : undefined
  return createElement(icon, {
    ...props,
    // Why: explicit status colors take precedence in source-control lists.
    style: { ...(color ? { color: `var(--file-icon-${color})` } : {}), ...style }
  })
}
