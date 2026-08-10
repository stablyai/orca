import type { RichMarkdownContextMenuTableTarget } from '../../shared/rich-markdown-context-menu'
import { translateMain } from '../i18n/main-i18n'
import {
  buildMarkdownMenuTemplate,
  buildNativeEditMenuTemplate,
  type EditableContextMenuWebContents
} from './editable-context-menu-templates'

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
      label: translateMain(
        'auto.main.window.editableContextMenu.addToDictionary',
        'Add to dictionary'
      ),
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
