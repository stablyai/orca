import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from './markdown-editor-document'
import { colors } from '../theme/mobile-theme'
import { MOBILE_RICH_MARKDOWN_EDITOR_DOCUMENT_BODY } from './mobile-rich-markdown-editor-document-body'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT } from './mobile-rich-markdown-editor-script'

export { escapeInjectedJavaScriptString } from './mobile-rich-markdown-editor-script-string'
export { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT } from './mobile-rich-markdown-editor-script'
export {
  MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH,
  MOBILE_WEB_MARKDOWN_EDITOR_PATH
} from './markdown-editor-document'

// Why: `https:` keeps the remote markdown images main rendered; plaintext `http:` stays blocked.
const MOBILE_RICH_MARKDOWN_EDITOR_FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'" />`

/**
 * The packaged document loads its script from the package and takes its policy from the native
 * response header, which is the only place that knows the per-session origin. The in-app WebView
 * has no server, so it carries its own meta policy over an inline script.
 */
type MarkdownEditorScript = { src: string } | { inline: true }

export function buildMobileRichMarkdownEditorHtml(
  script: MarkdownEditorScript = { inline: true }
): string {
  const policy = 'src' in script ? '' : `\n  ${MOBILE_RICH_MARKDOWN_EDITOR_FRAME_CSP}`
  const scriptElement =
    'src' in script
      ? `  <script src="${script.src}"></script>`
      : `  <script>\n${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT}\n  </script>`
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />${policy}
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
${scriptElement}
</body>
</html>`
}
