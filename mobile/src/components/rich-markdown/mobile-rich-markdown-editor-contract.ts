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
  | { type: 'keyboardInset'; bottom: number }

export type MobileRichMarkdownEditorProps = {
  content: string
  editable: boolean
  onChange: (content: string) => void
  onKeyboardInsetChange?: (bottom: number) => void
  onOpenLink: (url: string) => void
}

/** How a host delivers a command into whatever surface renders the editor document. */
export type MobileRichMarkdownEditorTransport = {
  setMarkdown: (markdown: string, generation: number) => void
  setEditable: (editable: boolean) => void
  runCommand: (command: MobileRichMarkdownCommand) => void
}
