import { createElement, type CSSProperties } from 'react'
import { getFileTypeIcon } from '@/lib/file-type-icons'

type FileTypeIconProps = {
  filePath: string | null | undefined
  className?: string
  style?: CSSProperties
}

export function FileTypeIcon({ filePath, className, style }: FileTypeIconProps): React.JSX.Element {
  return createElement(getFileTypeIcon(filePath), { 'aria-hidden': true, className, style })
}
