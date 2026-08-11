// Composed into the editor document after MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT, whose
// rememberSelection/selectionDroppedOnBlur this depends on.
export const MOBILE_RICH_MARKDOWN_KEYBOARD_DISMISS_SCRIPT = `
      function dismissKeyboard() {
        // Why: WebKit discards the DOM selection on blur, so capture the caret before it goes.
        rememberSelection();
        selectionDroppedOnBlur = true;
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
        editor.blur();
      }
`
