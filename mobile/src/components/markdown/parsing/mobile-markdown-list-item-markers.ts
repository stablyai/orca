import type { List, ListItem, Parent } from 'mdast'
import {
  keepTypedListItemNumber,
  type ListItemNumberStore
} from '../../../../../src/shared/markdown/chat-list-item-numbers'
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

const isList = (node: Parent): node is List => node.type === 'list'

const itemData: ListItemNumberStore<ListItem> = {
  read: (item) => item.data?.value,
  write: (item, typed) => {
    item.data = { ...item.data, value: typed }
  }
}

/** Chat keeps typed list numbers; GitHub text renumbers like GitHub. Call after the item opens.
 *  markdown-it's `info` is an ordered item's typed number, empty on a bullet. */
export function numberChatListItem(list: Parent, { info }: { info: string }, env: MathEnv): void {
  if (env.chatMath && info && isList(list)) {
    keepTypedListItemNumber(list, Number(info), itemData)
  }
}
