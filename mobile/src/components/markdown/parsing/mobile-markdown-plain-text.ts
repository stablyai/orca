import type { Nodes } from 'mdast'

/** The text a node draws, as mdast-util-to-string reads it. */
export function plainText(node: Nodes): string {
  if ('value' in node) {
    return node.value
  }
  if (node.type === 'image') {
    return node.alt ?? ''
  }
  return 'children' in node ? node.children.map(plainText).join('') : ''
}
