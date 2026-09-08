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

export type MobileRichMarkdownEditorProps = {
  content: string
  editable: boolean
  onChange: (content: string) => void
  onKeyboardInsetChange?: (bottom: number) => void
  onOpenLink?: (url: string) => void
}

export type MobileRichMarkdownEditorMessage =
  | { type: 'ready' }
  | { type: 'change'; markdown: string; generation: number }
  | { type: 'openLink'; url: string }
  | { type: 'keyboardInset'; bottom: number }

export type MobileRichMarkdownEditorTransport = {
  setMarkdown: (markdown: string, generation: number) => void
  setEditable: (editable: boolean) => void
  runCommand: (command: MobileRichMarkdownCommand) => void
}

export const MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL = 'orca-rich-markdown-editor-v1'

export type MobileRichMarkdownEditorFrameMessage =
  | {
      channel: typeof MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL
      frameToken: string
      direction: 'editor-to-host'
      payload: MobileRichMarkdownEditorMessage
    }
  | {
      channel: typeof MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL
      frameToken: string
      direction: 'host-to-editor'
      payload:
        | { type: 'setMarkdown'; markdown: string; generation: number }
        | { type: 'setEditable'; editable: boolean }
        | { type: 'runCommand'; command: MobileRichMarkdownCommand }
    }
