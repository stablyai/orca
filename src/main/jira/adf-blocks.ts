import type { BlockContent, Heading, ListItem, TableRow } from 'mdast'
import { adfInlineNodes } from './adf-text-marks'
import { adfChildren, adfPositiveInteger, adfRecord, adfString, type AdfRecord } from './adf-nodes'

type MediaRenderer = (node: AdfRecord) => string

function headingDepth(value: unknown): Heading['depth'] {
  if (value === 2 || value === 3 || value === 4 || value === 5 || value === 6) {
    return value
  }
  return 1
}

function simpleTable(node: AdfRecord, media: MediaRenderer): BlockContent[] | null {
  const rows: TableRow[] = []
  for (const rawRow of adfChildren(node.content)) {
    const cells = adfChildren(adfRecord(rawRow).content)
    const row: TableRow = { type: 'tableRow', children: [] }
    for (const rawCell of cells) {
      const cell = adfRecord(rawCell)
      const attrs = adfRecord(cell.attrs)
      const blocks = adfChildren(cell.content)
      if (
        adfPositiveInteger(attrs.colspan) !== 1 ||
        adfPositiveInteger(attrs.rowspan) !== 1 ||
        blocks.length !== 1 ||
        adfRecord(blocks[0]).type !== 'paragraph'
      ) {
        return null
      }
      row.children.push({
        type: 'tableCell',
        children: adfInlineNodes(adfRecord(blocks[0]).content, media, true)
      })
    }
    if (row.children.length) {
      rows.push(row)
    }
  }
  return rows.length ? [{ type: 'table', children: rows }] : []
}

function listItem(value: unknown, media: MediaRenderer): ListItem {
  return {
    type: 'listItem',
    spread: false,
    children: adfBlockNodes(adfRecord(value).content, media)
  }
}

function blockNode(value: unknown, media: MediaRenderer): BlockContent[] {
  const node = adfRecord(value)
  const children = () => adfBlockNodes(node.content, media)
  switch (node.type) {
    case 'doc':
      return children()
    case 'paragraph':
      return [{ type: 'paragraph', children: adfInlineNodes(node.content, media) }]
    case 'heading':
      return [
        {
          type: 'heading',
          depth: headingDepth(adfRecord(node.attrs).level),
          children: adfInlineNodes(node.content, media)
        }
      ]
    case 'bulletList':
    case 'orderedList':
      return [
        {
          type: 'list',
          ordered: node.type === 'orderedList',
          start:
            node.type === 'orderedList' ? adfPositiveInteger(adfRecord(node.attrs).order) : null,
          spread: false,
          children: adfChildren(node.content).map((item) => listItem(item, media))
        }
      ]
    case 'listItem':
      return listItem(node, media).children
    case 'codeBlock':
      return [
        {
          type: 'code',
          lang: adfString(adfRecord(node.attrs).language) || null,
          value: adfChildren(node.content)
            .map((child) => adfString(adfRecord(child).text))
            .join('')
        }
      ]
    case 'blockquote':
      return [{ type: 'blockquote', children: children() }]
    case 'rule':
      return [{ type: 'thematicBreak' }]
    case 'table':
      return simpleTable(node, media) ?? children()
    case 'media':
    case 'mediaInline':
      return [{ type: 'paragraph', children: [{ type: 'jiraMedia', value: media(node) }] }]
    default: {
      const blocks = children()
      if (blocks.length) {
        return blocks
      }
      const inline = adfInlineNodes([node], media)
      return inline.length ? [{ type: 'paragraph', children: inline }] : []
    }
  }
}

export function adfBlockNodes(value: unknown, media: MediaRenderer): BlockContent[] {
  return adfChildren(value).flatMap((node) => blockNode(node, media))
}
