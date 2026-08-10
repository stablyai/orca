import {
  type RichMarkdownContextMenuCommand,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget,
  richMarkdownContextMenuCommandChannel
} from '../../shared/rich-markdown-context-menu'
import { translateMain } from '../i18n/main-i18n'
import type { EditableContextMenuWebContents } from './editable-context-menu-web-contents'

export function markdownCommandItem(
  label: string,
  command: RichMarkdownContextMenuCommand,
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  tableTargetId?: string
): Electron.MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      const payload: RichMarkdownContextMenuCommandPayload = {
        command,
        ...point,
        ...(tableTargetId ? { tableTargetId } : {})
      }
      webContents.send(richMarkdownContextMenuCommandChannel, payload)
    }
  }
}

export function buildMarkdownTableMenuItems(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  tableTarget: RichMarkdownContextMenuTableTarget
): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('auto.main.window.editableContextMenu.table', 'Table'),
    submenu: [
      {
        ...markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.insertRowAbove', 'Insert row above'),
          'insert-row-above',
          webContents,
          point,
          tableTarget.targetId
        ),
        enabled: tableTarget.cellType !== 'header'
      },
      markdownCommandItem(
        translateMain('auto.main.window.editableContextMenu.insertRowBelow', 'Insert row below'),
        'insert-row-below',
        webContents,
        point,
        tableTarget.targetId
      ),
      {
        ...markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.deleteRow', 'Delete row'),
          'delete-row',
          webContents,
          point,
          tableTarget.targetId
        ),
        enabled: tableTarget.cellType !== 'header'
      },
      { type: 'separator' as const },
      markdownCommandItem(
        translateMain(
          'auto.main.window.editableContextMenu.insertColumnLeft',
          'Insert column left'
        ),
        'insert-column-left',
        webContents,
        point,
        tableTarget.targetId
      ),
      markdownCommandItem(
        translateMain(
          'auto.main.window.editableContextMenu.insertColumnRight',
          'Insert column right'
        ),
        'insert-column-right',
        webContents,
        point,
        tableTarget.targetId
      ),
      markdownCommandItem(
        translateMain('auto.main.window.editableContextMenu.deleteColumn', 'Delete column'),
        'delete-column',
        webContents,
        point,
        tableTarget.targetId
      ),
      { type: 'separator' as const },
      markdownCommandItem(
        translateMain('auto.main.window.editableContextMenu.deleteTable', 'Delete table'),
        'delete-table',
        webContents,
        point,
        tableTarget.targetId
      )
    ]
  }
}
