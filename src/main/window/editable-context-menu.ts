import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommand,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import { translateMain } from '../i18n/main-i18n'

type EditableContextMenuWebContents = Pick<
  Electron.WebContents,
  'replaceMisspelling' | 'send' | 'session'
>

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

function buildMarkdownMenuTemplate(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number },
  tableTarget: RichMarkdownContextMenuTableTarget | null
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
    { role: 'cut' },
    { role: 'copy' },
    editableContextPasteItem('Paste', webContents),
    editableContextPasteItem('Paste as plain text', webContents, { plainTextOnly: true }),
    { role: 'selectAll' }
  ]
}

function buildNativeEditMenuTemplate(
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'cut' },
    { role: 'copy' },
    editableContextPasteItem('Paste', webContents),
    editableContextPasteItem('Paste as plain text', webContents, { plainTextOnly: true }),
    { role: 'selectAll' }
  ]
}

export function buildEditableContextMenuTemplate(
  params: Electron.ContextMenuParams,
  webContents: EditableContextMenuWebContents,
  options?: { tableTarget?: RichMarkdownContextMenuTableTarget | null }
): Electron.MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return []
  }

  const suggestions = params.dictionarySuggestions.slice(0, 5)
  const isRichMarkdownSurface = params.formControlType === 'none'
  const template: Electron.MenuItemConstructorOptions[] = suggestions.map((suggestion) => ({
    label: suggestion,
    click: () => webContents.replaceMisspelling(suggestion)
  }))

  if (params.misspelledWord) {
    if (template.length > 0) {
      template.push({ type: 'separator' })
    }
    template.push({
      label: 'Add to dictionary',
      click: () => {
        webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      }
    })
  }

  if (template.length > 0) {
    template.push({ type: 'separator' })
  }
  template.push(
    ...(isRichMarkdownSurface
      ? buildMarkdownMenuTemplate(
          webContents,
          { x: params.x, y: params.y },
          options?.tableTarget ?? null
        )
      : buildNativeEditMenuTemplate(webContents))
  )

  return template
}

export function parseRichMarkdownContextMenuTableTarget(
  value: unknown
): RichMarkdownContextMenuTableTarget | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const target = value as Partial<RichMarkdownContextMenuTableTarget>
  if (
    (target.cellType !== 'body' && target.cellType !== 'header') ||
    typeof target.targetId !== 'string' ||
    target.targetId.length === 0 ||
    typeof target.x !== 'number' ||
    !Number.isFinite(target.x) ||
    typeof target.y !== 'number' ||
    !Number.isFinite(target.y)
  ) {
    return null
  }
  return {
    cellType: target.cellType,
    targetId: target.targetId,
    x: target.x,
    y: target.y
  }
}

export function matchingRichMarkdownContextMenuTableTarget(
  params: Electron.ContextMenuParams,
  target: RichMarkdownContextMenuTableTarget | null
): RichMarkdownContextMenuTableTarget | null {
  if (
    !target ||
    !params.isEditable ||
    params.formControlType !== 'none' ||
    params.x !== target.x ||
    params.y !== target.y
  ) {
    return null
  }
  return target
}
