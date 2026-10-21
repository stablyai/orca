import { createElement, type CSSProperties } from 'react'
import { getFileTypeIcon } from '@/lib/file-type-icons'

type FileTypeIconProps = {
  filePath: string | null | undefined
  className?: string
  style?: CSSProperties
}

/** The icon for a file path; one component so icon sources can change in one place. */
export function FileTypeIcon({ filePath, className, style }: FileTypeIconProps): React.JSX.Element {
  return createElement(getFileTypeIcon(filePath), { 'aria-hidden': true, className, style })
}
