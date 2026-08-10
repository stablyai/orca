import type { RichMarkdownContextMenuTableTarget } from '../../shared/rich-markdown-context-menu'
import { translateMain } from '../i18n/main-i18n'
import { buildMarkdownTableMenuItems, markdownCommandItem } from './editable-context-menu-table'
import type { EditableContextMenuWebContents } from './editable-context-menu-web-contents'

export type { EditableContextMenuWebContents } from './editable-context-menu-web-contents'

function editableContextPasteItem(
  label: string,
  webContents: EditableContextMenuWebContents,
  options?: { plainTextOnly?: boolean }
): Electron.MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      // Why: context-menu paste must share renderer ownership with keyboard and
      // app-menu paste so large text controls can chunk and terminals cannot
      // receive duplicate native paste.
      webContents.send('ui:editableContextPaste', {
        plainTextOnly: options?.plainTextOnly === true
      })
    }
  }
}

function clipboardEditItems(
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  return [
    {
      role: 'cut',
      label: translateMain('menu.cut', 'Cut')
    },
    {
      role: 'copy',
      label: translateMain('menu.copy', 'Copy')
    },
    editableContextPasteItem(translateMain('menu.paste', 'Paste'), webContents),
    editableContextPasteItem(
      translateMain('auto.main.window.editableContextMenu.pasteAsPlainText', 'Paste as plain text'),
      webContents,
      { plainTextOnly: true }
    ),
    {
      role: 'selectAll',
      label: translateMain('menu.selectAll', 'Select All')
    }
  ]
}

export function buildMarkdownMenuTemplate(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  tableTarget: RichMarkdownContextMenuTableTarget | null
): Electron.MenuItemConstructorOptions[] {
  return [
    markdownCommandItem(
      translateMain('auto.main.window.editableContextMenu.addLink', 'Add link'),
      'add-link',
      webContents,
      point
    ),
    { type: 'separator' },
    {
      label: translateMain('auto.main.window.editableContextMenu.format', 'Format'),
      submenu: [
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.bold', 'Bold'),
          'bold',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.italic', 'Italic'),
          'italic',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.strike', 'Strike'),
          'strike',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.inlineCode', 'Inline code'),
          'inline-code',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.codeBlock', 'Code block'),
          'code-block',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.quote', 'Quote'),
          'blockquote',
          webContents,
          point
        )
      ]
    },
    {
      label: translateMain('auto.main.window.editableContextMenu.paragraph', 'Paragraph'),
      submenu: [
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.bodyText', 'Body text'),
          'paragraph',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.heading1', 'Heading 1'),
          'heading-1',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.heading2', 'Heading 2'),
          'heading-2',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.heading3', 'Heading 3'),
          'heading-3',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.heading4', 'Heading 4'),
          'heading-4',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.heading5', 'Heading 5'),
          'heading-5',
          webContents,
          point
        ),
        { type: 'separator' },
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.bulletList', 'Bullet list'),
          'bullet-list',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.numberedList', 'Numbered list'),
          'ordered-list',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.checklist', 'Checklist'),
          'task-list',
          webContents,
          point
        )
      ]
    },
    {
      label: translateMain('auto.main.window.editableContextMenu.insert', 'Insert'),
      submenu: [
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.link', 'Link'),
          'add-link',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.image', 'Image'),
          'image',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.divider', 'Divider'),
          'divider',
          webContents,
          point
        ),
        markdownCommandItem(
          translateMain('auto.main.window.editableContextMenu.codeBlock', 'Code block'),
          'code-block',
          webContents,
          point
        )
      ]
    },
    ...(tableTarget ? [buildMarkdownTableMenuItems(webContents, point, tableTarget)] : []),
    { type: 'separator' },
    ...clipboardEditItems(webContents)
  ]
}

export function buildNativeEditMenuTemplate(
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  return clipboardEditItems(webContents)
}
