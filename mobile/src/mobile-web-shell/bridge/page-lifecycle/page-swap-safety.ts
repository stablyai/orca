type EditableField = Element & { readonly readOnly?: boolean; readonly disabled?: boolean }

const FIELDS = 'textarea, input, [contenteditable]:not([contenteditable="false"])'
const MODAL = '[aria-modal="true"]'

function unsentText(field: EditableField): string {
  if (!field.isConnected || field.readOnly === true || field.disabled === true) {
    return ''
  }
  const text = 'value' in field && typeof field.value === 'string' ? field.value : field.textContent
  return (text ?? '').trim()
}

export type PageSwapSafety = {
  // Answers one round. When a reload waits on it, the first input or opened sheet after a safe answer calls retract
  // once, so a slow page elsewhere cannot complete the round on this page's stale yes.
  answer(requestInFlight: boolean, retract: (() => void) | null): boolean
  // The app left; the earlier answer is already void.
  disarm(): void
  // The page moved to another screen: text typed on the one it left is no longer a draft here.
  navigated(): void
}

function opensModal(records: readonly MutationRecord[]): boolean {
  return records.some((record) =>
    record.type === 'attributes'
      ? record.target instanceof Element && record.target.matches(MODAL)
      : [...record.addedNodes].some(
          (node) =>
            node instanceof Element && (node.matches(MODAL) || node.querySelector(MODAL) !== null)
        )
  )
}

// Whether reloading onto a newer build now loses nothing: no draft, no sheet or dialog that may be partway through an
// action, and no request sent before the app left (an upload, a save) still unanswered.
// A draft is text the user typed: a page's own prefilled values (settings, an edit form) are not drafts, and React
// keeps a controlled field's defaultValue equal to its value, so comparing the two would hide every composer.
export function createPageSwapSafety(doc: Document): PageSwapSafety {
  const typed = new Map<EditableField, string>()
  // Text of typed fields that left the document: a composer React remounts carries it into a node nobody typed in.
  const carried = new Set<string>()
  let armed: (() => void) | null = null
  const fire = (): void => {
    const retract = armed
    disarm()
    retract?.()
  }
  const observer =
    typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver((records) => opensModal(records) && fire())
  function disarm(): void {
    armed = null
    observer?.disconnect()
  }
  doc.addEventListener(
    'input',
    (event) => {
      if (event.target instanceof Element) {
        typed.set(event.target, unsentText(event.target))
      }
      fire()
    },
    true
  )
  function hasDraft(): boolean {
    for (const [field, text] of typed) {
      if (!field.isConnected) {
        typed.delete(field)
        if (text !== '') {
          carried.add(text)
        }
      }
    }
    const fields: EditableField[] = [...doc.querySelectorAll(FIELDS)]
    return fields.some((field) => {
      const text = unsentText(field)
      // A matched field takes the draft over, so it is tracked as typed from here on.
      if (text !== '' && carried.delete(text)) {
        typed.set(field, text)
      }
      return text !== '' && typed.has(field)
    })
  }
  return {
    answer: (requestInFlight, retract) => {
      disarm()
      const safe = !requestInFlight && !hasDraft() && doc.querySelector(MODAL) === null
      if (safe && retract !== null) {
        armed = retract
        observer?.observe(doc, { subtree: true, childList: true, attributeFilter: ['aria-modal'] })
      }
      return safe
    },
    disarm,
    navigated: () => carried.clear()
  }
}
