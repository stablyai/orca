import {
  MOBILE_RICH_MARKDOWN_EDITOR_AFTER_KEYBOARD_DISMISS,
  MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_END
} from './mobile-rich-markdown-editor-document-suffix'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_PRIMARY } from './mobile-rich-markdown-editor-script-primary'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_SECONDARY } from './mobile-rich-markdown-editor-script-secondary'
import { MOBILE_RICH_MARKDOWN_KEYBOARD_INSET_SCRIPT } from './mobile-rich-markdown-editor-keyboard-inset-script'
import { MOBILE_RICH_MARKDOWN_KEYBOARD_DISMISS_SCRIPT } from './mobile-rich-markdown-keyboard-dismiss-script'
import { MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT } from './mobile-rich-markdown-selection-script'

/** The editor's whole program, independent of how a host delivers it to a WebView. */
export const MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT = `${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_PRIMARY}
${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_SECONDARY}${MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT}
${MOBILE_RICH_MARKDOWN_KEYBOARD_DISMISS_SCRIPT}${MOBILE_RICH_MARKDOWN_EDITOR_AFTER_KEYBOARD_DISMISS}${MOBILE_RICH_MARKDOWN_KEYBOARD_INSET_SCRIPT}${MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_END}`
