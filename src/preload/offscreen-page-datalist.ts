import type { OffscreenPageDatalistItem } from '../shared/offscreen-page-guest-channels'

// Electron's autofill agent trims the list it sends to the popup to these sizes.
const MAX_ITEMS = 512
const MAX_TEXT = 1024

const fold = (text: string): string => text.toLocaleLowerCase()
const squash = (text: string): string => fold(text).replace(/\s/g, '')
// HTMLOptionElement::label(): the attribute when present, else the collapsed text.
const optionLabel = (option: HTMLOptionElement): string =>
  option.getAttribute('label') ?? option.text.trim().replace(/\s+/g, ' ')

/** HTMLInputElement::FilteredDataListOptions, the rows Electron's datalist popup shows. */
export function filteredDatalistOptions(input: HTMLInputElement): OffscreenPageDatalistItem[] {
  const list = input.list
  if (!list) {
    return []
  }
  let editorValue = input.value
  if (input.multiple && input.type === 'email') {
    const emails = editorValue.split(',').filter(Boolean)
    editorValue = emails.length > 0 ? (emails.at(-1)?.trim() ?? '') : editorValue
  }
  // Why words: Blink keeps an option only when every typed word appears in its value or label.
  const words = [
    ...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(fold(editorValue))
  ]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment)
  const items: OffscreenPageDatalistItem[] = []
  for (const option of list.options) {
    const disabled = option.disabled || option.closest('optgroup')?.disabled === true
    if (option.value === '' || disabled) {
      continue
    }
    const text = optionLabel(option)
    const value = squash(option.value)
    const label = squash(text)
    if (words.every((word) => value.includes(word) || label.includes(word))) {
      items.push({
        value: option.value.slice(0, MAX_TEXT),
        label: option.value === text ? '' : text.slice(0, MAX_TEXT)
      })
    }
  }
  return items.slice(0, MAX_ITEMS)
}

function focusedInput(): HTMLInputElement | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement
  }
  return active instanceof HTMLInputElement ? active : null
}

/**
 * Answers main's question "what does the open datalist popup list?" from the frame that has focus.
 * Electron's popup reaches main only as pixels, and in an offscreen page not even those.
 */
export function answerDatalistQueries(
  onQuery: (answer: () => void) => void,
  send: (items: OffscreenPageDatalistItem[]) => void
): void {
  onQuery(() => {
    const input = focusedInput()
    if (document.hasFocus() && input?.list) {
      send(filteredDatalistOptions(input))
    }
  })
}
