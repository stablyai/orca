export type MobileRichMarkdownCommand =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'inlineCode'
  | 'codeBlock'
  | 'link'
  | 'image'

export type MobileRichMarkdownEditorMessage =
  | { type: 'ready' }
  | { type: 'change'; markdown: string; generation: number }
  | { type: 'openLink'; url: string }
  | { type: 'formatState'; focused: boolean; active: MobileRichMarkdownCommand[] }

/** Whether the editor has focus, and the toolbar commands whose style is under the caret. */
export type MobileRichMarkdownFormatState = {
  focused: boolean
  active: readonly MobileRichMarkdownCommand[]
}

export type MobileRichMarkdownEditorProps = {
  content: string
  editable: boolean
  onChange: (content: string) => void
  onFormatStateChange?: (state: MobileRichMarkdownFormatState) => void
  onOpenLink: (url: string) => void
}

/** How a host delivers a command into whatever surface renders the editor document. */
export type MobileRichMarkdownEditorTransport = {
  setMarkdown: (markdown: string, generation: number) => void
  setEditable: (editable: boolean) => void
  runCommand: (command: MobileRichMarkdownCommand) => void
}
