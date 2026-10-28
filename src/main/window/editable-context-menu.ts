import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommand,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import type { ContextMenuSpelling } from '../../shared/browser-guest-events'
import { translateMain } from '../i18n/main-i18n'
import { editableContextMenuLabels } from './editable-context-menu-labels'

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
      // Use renderer paste ownership for chunked text controls and to avoid duplicate native terminal paste.
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
  const labels = editableContextMenuLabels()
  return [
    markdownCommandItem(labels.addLink, 'add-link', webContents, point),
    { type: 'separator' },
    {
      label: labels.format,
      submenu: [
        markdownCommandItem(labels.bold, 'bold', webContents, point),
        markdownCommandItem(labels.italic, 'italic', webContents, point),
        markdownCommandItem(labels.strike, 'strike', webContents, point),
        markdownCommandItem(labels.inlineCode, 'inline-code', webContents, point),
        markdownCommandItem(labels.codeBlock, 'code-block', webContents, point),
        markdownCommandItem(labels.quote, 'blockquote', webContents, point)
      ]
    },
    {
      label: labels.paragraph,
      submenu: [
        markdownCommandItem(labels.bodyText, 'paragraph', webContents, point),
        markdownCommandItem(labels.heading1, 'heading-1', webContents, point),
        markdownCommandItem(labels.heading2, 'heading-2', webContents, point),
        markdownCommandItem(labels.heading3, 'heading-3', webContents, point),
        markdownCommandItem(labels.heading4, 'heading-4', webContents, point),
        markdownCommandItem(labels.heading5, 'heading-5', webContents, point),
        { type: 'separator' },
        markdownCommandItem(labels.bulletList, 'bullet-list', webContents, point),
        markdownCommandItem(labels.numberedList, 'ordered-list', webContents, point),
        markdownCommandItem(labels.checklist, 'task-list', webContents, point)
      ]
    },
    {
      label: labels.insert,
      submenu: [
        markdownCommandItem(labels.link, 'add-link', webContents, point),
        markdownCommandItem(labels.image, 'image', webContents, point),
        markdownCommandItem(labels.divider, 'divider', webContents, point),
        markdownCommandItem(labels.codeBlock, 'code-block', webContents, point)
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
    editableContextPasteItem(labels.paste, webContents),
    editableContextPasteItem(labels.pasteAsPlainText, webContents, { plainTextOnly: true }),
    { role: 'selectAll' }
  ]
}

function buildNativeEditMenuTemplate(
  params: Electron.ContextMenuParams,
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  const labels = editableContextMenuLabels()
  return [
    { role: 'cut' },
    { role: 'copy' },
    editableContextPasteItem(labels.paste, webContents),
    // Plain-text contenteditable composers already paste literally; omit redundant text-only mode.
    ...(params.formControlType !== 'none'
      ? [editableContextPasteItem(labels.pasteAsPlainText, webContents, { plainTextOnly: true })]
      : []),
    { role: 'selectAll' }
  ]
}

/** The spelling actions an editable context menu offers; Orca's window and browser pages share it. */
export function readContextMenuSpelling(
  params: Pick<Electron.ContextMenuParams, 'dictionarySuggestions' | 'misspelledWord'>
): ContextMenuSpelling {
  return {
    suggestions: params.dictionarySuggestions.slice(0, 5),
    misspelledWord: params.misspelledWord
  }
}

export function buildEditableContextMenuTemplate(
  params: Electron.ContextMenuParams,
  webContents: EditableContextMenuWebContents,
  options?: { tableTarget?: RichMarkdownContextMenuTableTarget | null; plainText?: boolean }
): Electron.MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return []
  }

  const { suggestions, misspelledWord } = readContextMenuSpelling(params)
  const isRichMarkdownSurface = params.formControlType === 'none' && options?.plainText !== true
  const template: Electron.MenuItemConstructorOptions[] = suggestions.map((suggestion) => ({
    label: suggestion,
    click: () => webContents.replaceMisspelling(suggestion)
  }))

  if (misspelledWord) {
    if (template.length > 0) {
      template.push({ type: 'separator' })
    }
    template.push({
      label: editableContextMenuLabels().addToDictionary,
      click: () => {
        webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
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
      : buildNativeEditMenuTemplate(params, webContents))
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
