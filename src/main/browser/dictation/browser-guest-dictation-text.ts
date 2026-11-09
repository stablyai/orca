import { dictationSeparators } from '../../../shared/dictation-transcript-spacing'

// Reads the text around the caret of the focused frame's editable field, or null when none is focused.
const READ_FOCUSED_FIELD_SCRIPT = `(() => {
  const limit = 200
  const field = document.activeElement
  const textInputTypes = ['text', 'search', 'url', 'tel', 'email', 'password']
  if (
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement && textInputTypes.includes(field.type))
  ) {
    if (field.readOnly || field.disabled) {
      return null
    }
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    return {
      before: field.value.slice(Math.max(0, start - limit), start),
      after: field.value.slice(end, end + limit)
    }
  }
  if (!(field instanceof HTMLElement) || !field.isContentEditable) {
    return null
  }
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return { before: '', after: '' }
  }
  const caret = selection.getRangeAt(0)
  const before = document.createRange()
  before.selectNodeContents(field)
  before.setEnd(caret.startContainer, caret.startOffset)
  const after = document.createRange()
  after.selectNodeContents(field)
  after.setStart(caret.endContainer, caret.endOffset)
  return { before: before.toString().slice(-limit), after: after.toString().slice(0, limit) }
})()`

type FocusedFieldText = { before: string; after: string }
type ScriptFrame = { executeJavaScript(code: string): Promise<unknown> }
type DictationGuest = {
  focusedFrame: ScriptFrame | null
  mainFrame: ScriptFrame
  isDestroyed(): boolean
  insertText(text: string): Promise<void>
}

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
  // A field inside an iframe belongs to that frame's document, not the top page's.
  const frame = guest.focusedFrame ?? guest.mainFrame
  const field: unknown = await frame.executeJavaScript(READ_FOCUSED_FIELD_SCRIPT).catch(() => null)
  if (!isFocusedFieldText(field) || guest.isDestroyed()) {
    return false
  }
  const { leading, trailing } = dictationSeparators(field.before, text, field.after)
  await guest.insertText(`${leading}${text}${trailing}`)
  return true
}
