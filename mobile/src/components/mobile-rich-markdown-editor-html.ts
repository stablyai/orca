import { RICH_MARKDOWN_EDITOR_MARKUP } from './rich-markdown/document-markup'
import { richMarkdownEditorStyle } from './rich-markdown/document-style'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT } from './mobile-rich-markdown-editor-script'

export { escapeInjectedJavaScriptString } from './mobile-rich-markdown-editor-script-string'
export { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT } from './mobile-rich-markdown-editor-script'

export function buildMobileRichMarkdownEditorHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <style>
${richMarkdownEditorStyle()}
  </style>
</head>
<body>
  ${RICH_MARKDOWN_EDITOR_MARKUP}
  <script>
${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT}
  </script>
</body>
</html>`
}
