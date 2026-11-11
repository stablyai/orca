import {
  DICTATION_TEXT_BLOCK_SELECTOR,
  dictationSeparators
} from '../../../shared/dictation-transcript-spacing'

// The focused text field of this frame's document, looking through open shadow roots, or null.
const FOCUSED_FIELD_EXPRESSION = `(() => {
  let field = document.activeElement
  while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement
  const typedInto = field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email'].includes(field.type))
  if (typedInto) return field.readOnly || field.disabled ? null : field
  return field instanceof HTMLElement && field.isContentEditable ? field : null
})()`

// Text around the caret of the focused field, so dictated words are spaced from their neighbours.
const READ_FOCUSED_FIELD_SCRIPT = `(() => {
  const limit = 200
  const field = ${FOCUSED_FIELD_EXPRESSION}
  if (!field) return null
  if (!field.isContentEditable) {
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    return {
      before: field.value.slice(Math.max(0, start - limit), start),
      after: field.value.slice(end, end + limit)
    }
  }
  const root = field.getRootNode()
  const selection = root.getSelection ? root.getSelection() : document.getSelection()
  if (!selection || selection.rangeCount === 0) return { before: '', after: '' }
  const caret = selection.getRangeAt(0)
  const blockOf = (node) => {
    const block = (node instanceof Element ? node : node.parentElement)?.closest(${JSON.stringify(DICTATION_TEXT_BLOCK_SELECTOR)})
    return block && field.contains(block) ? block : field
  }
  const before = document.createRange()
  before.selectNodeContents(blockOf(caret.startContainer))
  before.setEnd(caret.startContainer, caret.startOffset)
  const after = document.createRange()
  after.selectNodeContents(blockOf(caret.endContainer))
  after.setStart(caret.endContainer, caret.endOffset)
  return { before: before.toString().slice(-limit), after: after.toString().slice(0, limit) }
})()`

// execCommand types into the frame that owns the field; webContents.insertText only reaches the top frame.
// Rich-text editors get a cancelable beforeinput first; a cancel counts as landed only if the field's text then changes.
const typeIntoFocusedFieldScript = (text: string): string => `(() => {
  const text = ${JSON.stringify(text)}
  const field = ${FOCUSED_FIELD_EXPRESSION}
  if (!field) return false
  if (field.isContentEditable) {
    const previous = field.textContent
    const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text })
    if (!field.dispatchEvent(beforeInput)) {
      return new Promise((resolve) => setTimeout(() => resolve(field.textContent !== previous), 50))
    }
  }
  return document.execCommand('insertText', false, text)
})()`

type FocusedFieldText = { before: string; after: string }
type ScriptFrame = { executeJavaScript(code: string): Promise<unknown> }
type DictationGuest = { focusedFrame: ScriptFrame | null; mainFrame: ScriptFrame }

function isFocusedFieldText(value: unknown): value is FocusedFieldText {
  return (
    typeof value === 'object' &&
    value !== null &&
    'before' in value &&
    'after' in value &&
    typeof value.before === 'string' &&
    typeof value.after === 'string'
  )
}

/** Types dictated text into the page's focused field, spaced from its neighbours; false when no field is focused. */
export async function insertDictationTextIntoGuest(
  guest: DictationGuest,
  text: string
): Promise<boolean> {
  const frame = guest.focusedFrame ?? guest.mainFrame
  const field = await frame.executeJavaScript(READ_FOCUSED_FIELD_SCRIPT)
  if (!isFocusedFieldText(field)) {
    return false
  }
  const { leading, trailing } = dictationSeparators(field.before, text, field.after)
  const typed = await frame.executeJavaScript(
    typeIntoFocusedFieldScript(`${leading}${text}${trailing}`)
  )
  return typed === true
}
