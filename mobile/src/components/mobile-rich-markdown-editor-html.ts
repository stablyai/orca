import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../../src/shared/mobile-web/markdown-editor-csp'
import { colors } from '../theme/mobile-theme'
import { MOBILE_RICH_MARKDOWN_KEYBOARD_DISMISS_SCRIPT } from './mobile-rich-markdown-keyboard-dismiss-script'
import { MOBILE_RICH_MARKDOWN_KEYBOARD_INSET_SCRIPT } from './mobile-rich-markdown-editor-keyboard-inset-script'
import { MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT } from './mobile-rich-markdown-selection-script'
import { MOBILE_RICH_MARKDOWN_EDITOR_BODY_PRIMARY } from './mobile-rich-markdown-editor-body-primary'
import { MOBILE_RICH_MARKDOWN_EDITOR_BODY_SECONDARY } from './mobile-rich-markdown-editor-body-secondary'
import {
  MOBILE_RICH_MARKDOWN_EDITOR_AFTER_KEYBOARD_DISMISS,
  MOBILE_RICH_MARKDOWN_EDITOR_DOCUMENT_END
} from './mobile-rich-markdown-editor-document-suffix'

export { escapeInjectedJavaScriptString } from './mobile-rich-markdown-editor-script-string'
export { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../../src/shared/mobile-web/markdown-editor-csp'

// Why: `https:` keeps the remote markdown images main rendered; plaintext `http:` stays blocked.
const MOBILE_RICH_MARKDOWN_EDITOR_FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH}; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'" />`

export function buildMobileRichMarkdownEditorHtml(_options?: { isolatedFrame?: boolean }): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  ${MOBILE_RICH_MARKDOWN_EDITOR_FRAME_CSP}
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
      --accent-link: ${colors.accentBlue}${MOBILE_RICH_MARKDOWN_EDITOR_BODY_PRIMARY}
${MOBILE_RICH_MARKDOWN_EDITOR_BODY_SECONDARY}${MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT}
${MOBILE_RICH_MARKDOWN_KEYBOARD_DISMISS_SCRIPT}${MOBILE_RICH_MARKDOWN_EDITOR_AFTER_KEYBOARD_DISMISS}${MOBILE_RICH_MARKDOWN_KEYBOARD_INSET_SCRIPT}${MOBILE_RICH_MARKDOWN_EDITOR_DOCUMENT_END}`
}
