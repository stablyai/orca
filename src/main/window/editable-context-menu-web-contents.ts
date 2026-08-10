export type EditableContextMenuWebContents = Pick<
  Electron.WebContents,
  'replaceMisspelling' | 'send' | 'session'
>
