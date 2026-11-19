import type { ListItemData, Parent } from 'mdast'
import type { MathEnv } from '../math/mobile-markdown-math'

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

/** Chat means typed numbers literally ("4." is step 4); GitHub text renumbers like GitHub.
 *  markdown-it's `info` is an ordered item's typed number, empty on a bullet. */
export function typedItemNumber(
  { info }: { info: string },
  env: MathEnv
): ListItemData | undefined {
  return env.chatMath && info ? { value: Number(info) } : undefined
}
