type EditableContextMenuWebContents = Pick<Electron.WebContents, 'replaceMisspelling' | 'session'>

export function buildEditableContextMenuTemplate(
  params: Electron.ContextMenuParams,
  webContents: EditableContextMenuWebContents
): Electron.MenuItemConstructorOptions[] {
  if (!params.isEditable || !params.spellcheckEnabled) {
    return []
  }

  const suggestions = params.dictionarySuggestions.slice(0, 5)
  if (suggestions.length === 0 && !params.misspelledWord) {
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

  return template
}
