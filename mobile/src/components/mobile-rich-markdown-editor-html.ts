import { colors } from '../theme/mobile-theme'
import { MOBILE_RICH_MARKDOWN_EDITOR_DOCUMENT_BODY } from './mobile-rich-markdown-editor-document-body'
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
    :root {
      color-scheme: dark;
      --background: ${colors.bgBase};
      --editor-surface: ${colors.bgBase};
      --foreground: ${colors.textPrimary};
      --muted-foreground: ${colors.textSecondary};
      --muted: ${colors.bgRaised};
      --border: ${colors.borderSubtle};
      --primary: ${colors.textPrimary};
      --primary-foreground: ${colors.bgBase};
      --accent-link: ${colors.accentBlue}${MOBILE_RICH_MARKDOWN_EDITOR_DOCUMENT_BODY}
  <script>
${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT}
  </script>
</body>
</html>`
}
