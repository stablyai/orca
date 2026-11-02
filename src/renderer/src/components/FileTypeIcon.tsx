import { createElement, type CSSProperties } from 'react'
import { Folder, FolderOpen } from 'lucide-react'
import {
  getFileTypeIcon,
  getPluginFileTypeIconIndex,
  getPluginFolderIconIndex
} from '@/lib/file-type-icons'
import { PLUGIN_ICON_ATTRIBUTE, useActivePluginIconTheme } from '@/store/plugin-icon-themes'

type IconProps = { className?: string; style?: CSSProperties }

function PluginIcon({ index, className, style }: IconProps & { index: number }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      {...{ [PLUGIN_ICON_ATTRIBUTE]: index }}
      className={className}
      style={style}
    />
  )
}

/** The icon for a file path; one component so icon sources can change in one place. */
export function FileTypeIcon({
  filePath,
  className,
  style
}: IconProps & { filePath: string | null | undefined }): React.JSX.Element {
  const index = getPluginFileTypeIconIndex(
    useActivePluginIconTheme((s) => s.theme),
    filePath
  )
  return index === null ? (
    createElement(getFileTypeIcon(filePath), { 'aria-hidden': true, className, style })
  ) : (
    <PluginIcon index={index} className={className} style={style} />
  )
}

/** A folder's icon; `folderPath` lets an icon theme pick one for its name, such as `src`. */
export function FolderIcon({
  folderPath,
  open,
  className,
  style
}: IconProps & { folderPath?: string; open: boolean }): React.JSX.Element {
  const index = getPluginFolderIconIndex(
    useActivePluginIconTheme((s) => s.theme),
    folderPath,
    open
  )
  return index === null ? (
    createElement(open ? FolderOpen : Folder, { 'aria-hidden': true, className, style })
  ) : (
    <PluginIcon index={index} className={className} style={style} />
  )
}
