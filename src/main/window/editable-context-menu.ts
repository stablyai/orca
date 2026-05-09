import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommand,
  type RichMarkdownContextMenuCommandPayload
} from '../../shared/rich-markdown-context-menu'

type EditableContextMenuWebContents = Pick<
  Electron.WebContents,
  'replaceMisspelling' | 'send' | 'session'
>

function markdownCommandItem(
  label: string,
  command: RichMarkdownContextMenuCommand,
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number }
): Electron.MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      const payload: RichMarkdownContextMenuCommandPayload = { command, ...point }
      webContents.send(richMarkdownContextMenuCommandChannel, payload)
    }
  }
}

function buildMarkdownMenuTemplate(
  webContents: EditableContextMenuWebContents,
  point: { x: number; y: number }
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
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
    { role: 'selectAll' }
  ]
}

function buildNativeEditMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
    { role: 'selectAll' }
  ]
}

export function buildEditableContextMenuTemplate(
  params: Electron.ContextMenuParams,
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  if (!params.isEditable) {
    return []
  }

  const suggestions = params.dictionarySuggestions.slice(0, 5)
  const isRichMarkdownSurface = params.formControlType === 'none'
  if (!isRichMarkdownSurface && suggestions.length === 0 && !params.misspelledWord) {
    return []
  }

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
      ? buildMarkdownMenuTemplate(webContents, { x: params.x, y: params.y })
      : buildNativeEditMenuTemplate())
  )

  return template
}
