import { renderInline } from './markdown-inline-render'
import { listKind, type ParsedListItem } from './markdown-list-parse'
import type { RichMarkdownEditorScope } from './document-scope'

/**
 * A parsed list tree as markup, one list element per run of a single kind.
 *
 * A task item's checkbox mirrors the surface's own editability, because a checkbox left enabled
 * under a read-only document is a control the user can move and the document will not record.
 */
export function renderListItems(scope: RichMarkdownEditorScope, items: ParsedListItem[]): string {
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
        const children = item.children.length ? renderListItems(scope, item.children) : ''
        if (kind === 'task') {
          const checked = item.task === true
          return (
            `<li data-checked="${String(checked)}"><label contenteditable="false">` +
            `<input type="checkbox" ${checked ? 'checked ' : ''}${scope.editable ? '' : 'disabled '}/>` +
            `</label><div><p>${renderInline(item.text)}</p>${children}</div></li>`
          )
        }
        const orderedAttrs =
          kind === 'ol' && item.orderedNumber !== null
            ? ` value="${item.orderedNumber}" data-list-number="${item.orderedNumber}"`
            : ''
        return `<li${orderedAttrs}><p>${renderInline(item.text)}</p>${children}</li>`
      })
      .join('')
    html.push(`<${tag}${attrs}>${rendered}</${tag}>`)
  }
  return html.join('')
}
