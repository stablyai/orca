import { emitChange } from './editor-content'
import { applySelectionRange, caretRangeAtPoint, focusEditor } from './editor-selection'
import { editorElement } from './editor-surface'
import { post } from './host-bridge'
import { runCommand } from './editor-commands'
import type { RichMarkdownEditorScope } from './document-scope'

/** What the event landed on, for a target that may be a text node or nothing at all. */
function closestFrom(target: EventTarget | null, selector: string): Element | null {
  return target instanceof Element ? target.closest(selector) : null
}

function checkboxAt(target: EventTarget | null): HTMLInputElement | null {
  const input = closestFrom(target, 'input[type="checkbox"]')
  return input instanceof HTMLInputElement ? input : null
}

/** The markup carries the tick, because it is what the next serialization reads. */
function mirrorCheckedState(input: HTMLInputElement) {
  const item = input.closest('li')
  if (item) {
    item.setAttribute('data-checked', input.checked ? 'true' : 'false')
  }
}

// Mirrors isExternalMarkdownImageSrc in session/markdown-relative-image-srcs.ts, kept local
// because this module ships inside the WebView document bundle and must not pull RPC code.
const EXTERNAL_IMAGE_SRC = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** A tapped image opens on the host: zoomed when a worktree file backs it, else as a link. */
function handleImageTap(scope: RichMarkdownEditorScope, image: Element, event: MouseEvent): void {
  event.preventDefault()
  const src = image.getAttribute('data-orca-src') ?? image.getAttribute('src') ?? ''
  if (EXTERNAL_IMAGE_SRC.test(src)) {
    post(scope, { type: 'openLink', url: src })
    return
  }
  post(scope, { type: 'openImage', src })
}

function handleInput(scope: RichMarkdownEditorScope, event: Event) {
  // The flag is cleared for a checkbox too, as it always was: only the change is `change`'s, since
  // one tap raises click, input and change and each of the three used to report.
  scope.selectionDroppedOnBlur = false
  if (checkboxAt(event.target) || !scope.editable) {
    return
  }
  emitChange(scope)
}

function handleChange(scope: RichMarkdownEditorScope, event: Event) {
  const input = checkboxAt(event.target)
  if (input) {
    if (!scope.editable) {
      event.preventDefault()
      return
    }
    mirrorCheckedState(input)
  }
  if (scope.editable) {
    emitChange(scope)
  }
}

function handleClick(scope: RichMarkdownEditorScope, event: MouseEvent) {
  // The image wins over a wrapping link and over the caret refocus below: a tap means zoom.
  const image = closestFrom(event.target, 'img')
  if (image) {
    handleImageTap(scope, image, event)
    return
  }
  const link = closestFrom(event.target, 'a[href]')
  if (link) {
    event.preventDefault()
    post(scope, { type: 'openLink', url: link.getAttribute('href') ?? '' })
    return
  }
  if (!checkboxAt(event.target)) {
    if (!scope.editable) {
      return
    }
    // Why: a task-list label forwards its click to the checkbox, so refocusing here would steal it and re-open the keyboard.
    const uneditable = closestFrom(event.target, '[contenteditable="false"]')
    if (uneditable && uneditable !== editorElement(scope)) {
      return
    }
    scope.selectionDroppedOnBlur = false
    if (scope.getDocument().activeElement === editorElement(scope)) {
      return
    }
    // Why: refocusing after a dismissal otherwise types at the stale caret, not where the user tapped.
    const caret = caretRangeAtPoint(scope, event.clientX, event.clientY)
    focusEditor(scope)
    if (caret && editorElement(scope).contains(caret.commonAncestorContainer)) {
      applySelectionRange(scope, caret)
    }
    return
  }
  // The tick and the change both come from `change`, which this same tap raises; a read-only
  // document refuses the toggle here, which is the only thing left for a click to decide.
  if (!scope.editable) {
    event.preventDefault()
  }
}

function handleKeydown(scope: RichMarkdownEditorScope, event: KeyboardEvent) {
  // Both modifiers, because the same document runs under a Mac keyboard and a Windows one.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    void runCommand(scope, 'bold')
  }
}

/** The four listeners the surface carries, installed per document and taken off by `stop`. */
export function startEditorListeners(scope: RichMarkdownEditorScope) {
  const editor = editorElement(scope)
  const onInput = (event: Event) => handleInput(scope, event)
  const onChange = (event: Event) => handleChange(scope, event)
  const onClick = (event: MouseEvent) => handleClick(scope, event)
  const onKeydown = (event: KeyboardEvent) => handleKeydown(scope, event)
  editor.addEventListener('input', onInput)
  editor.addEventListener('change', onChange)
  editor.addEventListener('click', onClick)
  editor.addEventListener('keydown', onKeydown)
  scope.removeEditorListeners = () => {
    editor.removeEventListener('input', onInput)
    editor.removeEventListener('change', onChange)
    editor.removeEventListener('click', onClick)
    editor.removeEventListener('keydown', onKeydown)
  }
}

export function stopEditorListeners(scope: RichMarkdownEditorScope) {
  scope.removeEditorListeners?.()
  scope.removeEditorListeners = null
}
