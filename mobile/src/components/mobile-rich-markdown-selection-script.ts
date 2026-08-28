// Caret and selection management for the WebView editor. Split out so the editor
// document script stays inside its line budget.
export const MOBILE_RICH_MARKDOWN_SELECTION_SCRIPT = `
      var savedSelectionRange = null;
      var selectionDroppedOnBlur = false;

      function focusEditor() {
        editor.focus();
      }

      function rememberSelection() {
        var selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        var range = selection.getRangeAt(0);
        if (editor.contains(range.commonAncestorContainer)) savedSelectionRange = range.cloneRange();
      }

      function applySelectionRange(range) {
        var selection = window.getSelection();
        if (!selection) return;
        selection.removeAllRanges();
        selection.addRange(range);
        savedSelectionRange = range.cloneRange();
      }

      function caretRangeAtPoint(x, y) {
        if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
        if (!document.caretPositionFromPoint) return null;
        var position = document.caretPositionFromPoint(x, y);
        if (!position) return null;
        var range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      }

      function restoreSelectionOrEnd() {
        focusEditor();
        var selection = window.getSelection();
        if (!selection) return;
        // Why: the blur dropped the live selection, so commands would otherwise insert at the document end.
        if (selectionDroppedOnBlur && savedSelectionRange && editor.contains(savedSelectionRange.commonAncestorContainer)) {
          selectionDroppedOnBlur = false;
          applySelectionRange(savedSelectionRange);
          return;
        }
        if (selection.rangeCount > 0) return;
        var range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        applySelectionRange(range);
      }

      function wrapSelection(tagName) {
        restoreSelectionOrEnd();
        var selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        var range = selection.getRangeAt(0);
        if (range.collapsed) return;
        var wrapper = document.createElement(tagName);
        try {
          range.surroundContents(wrapper);
        } catch (_error) {
          wrapper.appendChild(range.extractContents());
          range.insertNode(wrapper);
        }
        selection.removeAllRanges();
        selection.selectAllChildren(wrapper);
        emitChange();
      }
`
