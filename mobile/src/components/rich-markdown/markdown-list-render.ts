import { openingFence } from './markdown-code-fence'
import { renderInline } from './markdown-inline-render'
import { listKind, type ParsedListItem } from './markdown-list-parse'
import type { RichMarkdownEditorScope } from './document-scope'

// The leading lines stay one inline paragraph so block syntax on the marker line (`- # Title`) reads as text.
function itemContent(item: ParsedListItem, renderBlocks: (markdown: string) => string): string {
  if (item.blockSource === undefined) {
    return `<p>${renderInline(item.text, true)}</p>`
  }
  const lines = item.blockSource.split('\n')
  let lead = 0
  while (lead < lines.length && lines[lead]?.trim() && !openingFence(lines[lead] ?? '')) {
    lead += 1
  }
  const paragraph = lines.slice(0, lead).join('\n')
  return (
    (paragraph ? `<p>${renderInline(paragraph, true).replace(/\n/g, '<br />')}</p>` : '') +
    renderBlocks(lines.slice(lead).join('\n'))
  )
}

// Render one list per same-kind run; disable task checkboxes under read-only surface or user toggles would go unrecorded.
export function renderListItems(
  scope: RichMarkdownEditorScope,
  items: ParsedListItem[],
  renderBlocks: (markdown: string) => string
): string {
  const html: string[] = []
  let index = 0
  while (index < items.length) {
    const kind = listKind(items[index]!)
    const group: ParsedListItem[] = []
    while (index < items.length && listKind(items[index]!) === kind) {
      group.push(items[index]!)
      index += 1
    }
    const tag = kind === 'ol' ? 'ol' : 'ul'
    const attrs =
      kind === 'task'
        ? ' data-type="taskList"'
        : kind === 'ol' && group[0]!.orderedNumber !== null
          ? ` start="${group[0]!.orderedNumber}"`
          : ''
    const rendered = group
      .map((item) => {
        const children = item.children.length
          ? renderListItems(scope, item.children, renderBlocks)
          : ''
        if (kind === 'task') {
          const checked = item.task === true
          return (
            `<li data-checked="${String(checked)}"><label contenteditable="false">` +
            `<input type="checkbox" ${checked ? 'checked ' : ''}${scope.editable ? '' : 'disabled '}/>` +
            `</label><div>${itemContent(item, renderBlocks)}${children}</div></li>`
          )
        }
        const orderedAttrs =
          kind === 'ol' && item.orderedNumber !== null
            ? ` value="${item.orderedNumber}" data-list-number="${item.orderedNumber}"`
            : ''
        return `<li${orderedAttrs}>${itemContent(item, renderBlocks)}${children}</li>`
      })
      .join('')
    html.push(`<${tag}${attrs}>${rendered}</${tag}>`)
  }
  return html.join('')
}
