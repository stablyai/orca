import {
  richMarkdownContextMenuCommandChannel,
  richMarkdownDefaultViewCommands,
  type RichMarkdownContextMenuCommand,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import {
  MARKDOWN_DEFAULT_VIEW_MODES,
  type MarkdownDefaultViewMode
} from '../../shared/markdown-default-view-mode'
import { translateMain } from '../i18n/main-i18n'
import {
  editableContextPasteItem,
  type EditableContextMenuWebContents
} from './editable-context-menu-web-contents'

function markdownCommandItem(
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

function defaultMarkdownViewSubmenu(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  activeMode: MarkdownDefaultViewMode
): Electron.MenuItemConstructorOptions {
  const labels: Record<MarkdownDefaultViewMode, string> = {
    source: translateMain('auto.main.window.editableContextMenu.defaultViewSource', 'Source'),
    rich: translateMain('auto.main.window.editableContextMenu.defaultViewRich', 'Rich Editor'),
    preview: translateMain('auto.main.window.editableContextMenu.defaultViewPreview', 'Preview')
  }
  return {
    label: translateMain(
      'auto.main.window.editableContextMenu.defaultMarkdownView',
      'Default Markdown View'
    ),
    submenu: MARKDOWN_DEFAULT_VIEW_MODES.map((mode) => ({
      ...markdownCommandItem(
        labels[mode],
        richMarkdownDefaultViewCommands[mode],
        webContents,
        point
      ),
      type: 'radio' as const,
      checked: mode === activeMode
    }))
  }
}

export function buildMarkdownMenuTemplate(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  tableTarget: RichMarkdownContextMenuTableTarget | null,
  markdownDefaultViewMode: MarkdownDefaultViewMode
): Electron.MenuItemConstructorOptions[] {
  return [
    markdownCommandItem('Add link', 'add-link', webContents, point),
    { type: 'separator' },
    {
      label: 'Format',
      submenu: [
        markdownCommandItem('Bold', 'bold', webContents, point),
        markdownCommandItem('Italic', 'italic', webContents, point),
        markdownCommandItem('Strike', 'strike', webContents, point),
        markdownCommandItem('Inline code', 'inline-code', webContents, point),
        markdownCommandItem('Code block', 'code-block', webContents, point),
        markdownCommandItem('Quote', 'blockquote', webContents, point)
      ]
    },
    {
      label: 'Paragraph',
      submenu: [
        markdownCommandItem('Body text', 'paragraph', webContents, point),
        markdownCommandItem('Heading 1', 'heading-1', webContents, point),
        markdownCommandItem('Heading 2', 'heading-2', webContents, point),
        markdownCommandItem('Heading 3', 'heading-3', webContents, point),
        markdownCommandItem('Heading 4', 'heading-4', webContents, point),
        markdownCommandItem('Heading 5', 'heading-5', webContents, point),
        { type: 'separator' },
        markdownCommandItem('Bullet list', 'bullet-list', webContents, point),
        markdownCommandItem('Numbered list', 'ordered-list', webContents, point),
        markdownCommandItem('Checklist', 'task-list', webContents, point)
      ]
    },
    {
      label: 'Insert',
      submenu: [
        markdownCommandItem('Link', 'add-link', webContents, point),
        markdownCommandItem('Image', 'image', webContents, point),
        markdownCommandItem('Divider', 'divider', webContents, point),
        markdownCommandItem('Code block', 'code-block', webContents, point)
      ]
    },
    ...(tableTarget
      ? [
          {
            label: translateMain('auto.main.window.editableContextMenu.table', 'Table'),
            submenu: [
              {
                ...markdownCommandItem(
                  translateMain(
                    'auto.main.window.editableContextMenu.insertRowAbove',
                    'Insert row above'
                  ),
                  'insert-row-above',
                  webContents,
                  point,
                  tableTarget.targetId
                ),
                enabled: tableTarget.cellType !== 'header'
              },
              markdownCommandItem(
                translateMain(
                  'auto.main.window.editableContextMenu.insertRowBelow',
                  'Insert row below'
                ),
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
        ]
      : []),
    { type: 'separator' },
    defaultMarkdownViewSubmenu(webContents, point, markdownDefaultViewMode),
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    editableContextPasteItem('Paste', webContents),
    editableContextPasteItem('Paste as plain text', webContents, { plainTextOnly: true }),
    { role: 'selectAll' }
  ]
}
