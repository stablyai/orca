export type EditableContextMenuWebContents = Pick<
  Electron.WebContents,
  'replaceMisspelling' | 'send' | 'session'
>

export function editableContextPasteItem(
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
