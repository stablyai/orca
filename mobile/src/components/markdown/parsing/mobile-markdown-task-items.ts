import type { Parent } from 'mdast'

const TASK_MARKER = /^\[([ xX])\](?:\s+|$)/

/** GitHub task list items: `[ ]` or `[x]` opening the item's first paragraph. */
export function readTaskMarker(item: Parent & { checked?: boolean | null }): void {
  const paragraph = item.children[0]
  const text = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined
  const marker = text?.type === 'text' ? TASK_MARKER.exec(text.value) : null
  if (text?.type === 'text' && marker) {
    item.checked = marker[1] !== ' '
    text.value = text.value.slice(marker[0].length)
  }
}
