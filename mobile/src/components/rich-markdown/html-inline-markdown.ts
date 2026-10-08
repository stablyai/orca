/** A node's text with non-breaking spaces turned back into the spaces the source wrote. */
export function textContent(node: Node): string {
  return (node.textContent ?? '').replace(/ /g, ' ')
}

/**
 * One node of the editable surface as inline markdown.
 *
 * A task item's `<label>` is the checkbox's chrome rather than content, so it serializes to
 * nothing and the list writer supplies the marker instead.
 */
export function inlineMarkdown(node: Node | null | undefined): string {
  if (!node) {
    return ''
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return textContent(node)
  }
  if (!(node instanceof Element)) {
    return ''
  }
  const tag = node.tagName.toLowerCase()
  if (tag === 'br') {
    return '\n'
  }
  if (tag === 'strong' || tag === 'b') {
    return `**${inlineChildren(node)}**`
  }
  if (tag === 'em' || tag === 'i') {
    return `*${inlineChildren(node)}*`
  }
  if (tag === 's' || tag === 'del' || tag === 'strike') {
    return `~~${inlineChildren(node)}~~`
  }
  if (tag === 'code' && node.parentElement && node.parentElement.tagName.toLowerCase() !== 'pre') {
    return `\`${textContent(node)}\``
  }
  if (tag === 'a') {
    return `[${inlineChildren(node)}](${node.getAttribute('href') ?? ''})`
  }
  if (tag === 'img') {
    return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
  }
  if (tag === 'label') {
    return ''
  }
  return inlineChildren(node)
}

export function inlineChildren(element: Element): string {
  return Array.from(element.childNodes)
    .map((child) => inlineMarkdown(child))
    .join('')
}
