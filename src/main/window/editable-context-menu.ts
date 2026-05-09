import {
  richMarkdownContextMenuCommandChannel,
  type RichMarkdownContextMenuCommand
} from '../../shared/rich-markdown-context-menu'

type EditableContextMenuWebContents = Pick<
  Electron.WebContents,
  'replaceMisspelling' | 'send' | 'session'
>

function markdownCommandItem(
  label: string,
  command: RichMarkdownContextMenuCommand,
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions {
  return {
    label,
    click: () => {
      webContents.send(richMarkdownContextMenuCommandChannel, command)
    }
  }
}

function buildMarkdownMenuTemplate(
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  return [
    markdownCommandItem('Add link', 'add-link', webContents),
    { type: 'separator' },
    {
      label: 'Format',
      submenu: [
        markdownCommandItem('Bold', 'bold', webContents),
        markdownCommandItem('Italic', 'italic', webContents),
        markdownCommandItem('Strike', 'strike', webContents),
        markdownCommandItem('Inline code', 'inline-code', webContents),
        markdownCommandItem('Code block', 'code-block', webContents),
        markdownCommandItem('Quote', 'blockquote', webContents)
      ]
    },
    {
      label: 'Paragraph',
      submenu: [
        markdownCommandItem('Body text', 'paragraph', webContents),
        markdownCommandItem('Heading 1', 'heading-1', webContents),
        markdownCommandItem('Heading 2', 'heading-2', webContents),
        markdownCommandItem('Heading 3', 'heading-3', webContents),
        { type: 'separator' },
        markdownCommandItem('Bullet list', 'bullet-list', webContents),
        markdownCommandItem('Numbered list', 'ordered-list', webContents),
        markdownCommandItem('Checklist', 'task-list', webContents)
      ]
    },
    {
      label: 'Insert',
      submenu: [
        markdownCommandItem('Link', 'add-link', webContents),
        markdownCommandItem('Image', 'image', webContents),
        markdownCommandItem('Divider', 'divider', webContents),
        markdownCommandItem('Code block', 'code-block', webContents)
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
      ? buildMarkdownMenuTemplate(webContents)
      : buildNativeEditMenuTemplate())
  )

  return template
}
