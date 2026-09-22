import { inlineChildren } from './html-inline-markdown'

/**
 * An item's own text: its label and any nested list taken off first.
 *
 * On a copy, because both belong to the live document — the label carries the checkbox the user
 * ticks, and the nested lists are serialized separately at their own indentation.
 */
export function listItemText(item: Element): string {
  const clone = item.cloneNode(true)
  // `cloneNode` is typed as returning a `Node`; an element's deep copy is an element.
  if (!(clone instanceof Element)) {
    return ''
  }
  clone.querySelectorAll('label').forEach((label) => label.remove())
  clone.querySelectorAll('ul, ol').forEach((list) => list.remove())
  return inlineChildren(clone).trim()
}

/** The lists directly inside an item, rather than every list anywhere beneath it. */
export function directNestedLists(item: Element): Element[] {
  return Array.from(item.querySelectorAll('ul, ol')).filter((list) => list.closest('li') === item)
}

/**
 * Whether an element carries a list that no list item owns, and so is a block of its own.
 *
 * The mirror of `directNestedLists`: a list under an `li` is that item's, serialized at its own
 * indentation, and any other list is a block wherever the engine put it — including inside a `<p>`.
 */
export function holdsUnownedList(element: Element): boolean {
  return Array.from(element.querySelectorAll('ul, ol')).some((list) => list.closest('li') === null)
}

/**
 * A list element as markdown, two spaces deeper per level of nesting.
 *
 * An ordered item's own number is preferred over its position, because the browser renumbers a
 * pasted or split item in the markup, and the source has to say what the surface shows.
 */
export function listMarkdown(element: Element, depth: number): string {
  const tag = element.tagName.toLowerCase()
  const isTask = element.getAttribute('data-type') === 'taskList'
  const parsedStart = tag === 'ol' ? Number.parseInt(element.getAttribute('start') ?? '1', 10) : 1
  const orderedStart = Number.isFinite(parsedStart) ? parsedStart : 1
  const indent = '  '.repeat(depth)
  return Array.from(element.children)
    .map((item, index) => {
      if (item.tagName.toLowerCase() !== 'li') {
        return ''
      }
      let marker: string
      if (isTask) {
        const input = item.querySelector<HTMLInputElement>('input[type="checkbox"]')
        marker = `- [${input && input.checked ? 'x' : ' '}] `
      } else {
        // `||` rather than `??`: an empty attribute is no number, and the next source answers.
        const listNumber = item.getAttribute('data-list-number') || item.getAttribute('value')
        marker = tag === 'ol' ? `${listNumber || orderedStart + index}. ` : '- '
      }
      const line = indent + marker + listItemText(item)
      const nested = directNestedLists(item)
        .map((list) => listMarkdown(list, depth + 1))
        .filter(Boolean)
        .join('\n')
      return nested ? `${line}\n${nested}` : line
    })
    .filter(Boolean)
    .join('\n')
}
