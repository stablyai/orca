// Odoo stores task descriptions and chatter messages as HTML produced by its
// own editor, which emits a narrow, predictable tag set. Orca's task surfaces
// speak markdown, so this module converts in both directions at the boundary.
import { marked } from 'marked'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ugrave: 'ù',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  rsquo: '’'
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

function escapeMarkdown(value: string): string {
  // Only the markers that would silently restructure the rendered output; a
  // full escape makes ordinary prose unreadable.
  return value.replace(/([\\`*_[\]])/g, '\\$1')
}

function attribute(tag: string, name: string): string | null {
  // The left boundary keeps `href` from matching inside `data-orig-href`, which
  // would otherwise win as the first match in the tag.
  const match = new RegExp(`(?<![-\\w])${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag)
  const raw = match?.[2] ?? match?.[3]
  return raw === undefined ? null : decodeEntities(raw)
}

function collapseBlankLines(value: string): string {
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type ListFrame = { ordered: boolean; index: number }

type TableState = {
  rows: string[][]
  // First row that carries <th> (or lives in <thead>); GFM needs a header row.
  headerRowIndex: number
}

/** Flattens converted cell content to a single GFM-table-safe line. */
function flattenTableCell(parts: string[]): string {
  return parts.join('').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
}

/** Renders accumulated rows as a GitHub-flavored markdown table. */
function renderGfmTable(table: TableState): string {
  if (table.rows.length === 0) {
    return ''
  }
  const headerIndex = table.headerRowIndex >= 0 ? table.headerRowIndex : 0
  const columns = Math.max(...table.rows.map((row) => row.length))
  const toLine = (row: string[]): string => {
    const cells = [...row]
    while (cells.length < columns) {
      cells.push('')
    }
    return `| ${cells.join(' | ')} |`
  }
  const lines = [
    toLine(table.rows[headerIndex] ?? []),
    `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`
  ]
  table.rows.forEach((row, index) => {
    if (index !== headerIndex) {
      lines.push(toLine(row))
    }
  })
  return lines.join('\n')
}

/**
 * Converts an Odoo chatter/description HTML body to markdown.
 *
 * Scans the tag stream rather than parsing a full DOM: the input is
 * editor-generated and well-formed, and the main process has no DOM.
 */
export function chatterHtmlToMarkdown(html: string): string {
  if (!html) {
    return ''
  }

  // Odoo never emits these, so their presence means untrusted paste-through.
  const source = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')

  const out: string[] = []
  const listStack: ListFrame[] = []
  let pendingLink: string | null = null
  let inPre = false
  let cursor = 0
  // Table capture: inline/text writes redirect into the active cell so its
  // content can be flattened onto one GFM row when </td>/</th> closes.
  let table: TableState | null = null
  let tableRow: string[] | null = null
  let tableCell: string[] | null = null
  let inThead = false
  let rowHasHeaderCell = false

  const tagPattern = /<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi
  let match: RegExpExecArray | null

  // Inline/text goes to the open cell when capturing a table, otherwise to out.
  const sink = (): string[] => tableCell ?? out
  // Block separators must not break a GFM row: collapse to a space inside a cell.
  const blockBreak = (value: string): void => {
    if (tableCell) {
      tableCell.push(' ')
    } else {
      out.push(value)
    }
  }

  const pushText = (raw: string): void => {
    if (!raw) {
      return
    }
    // Whitespace between table structural tags is not cell content.
    if (table && !tableCell) {
      return
    }
    const target = sink()
    if (inPre) {
      target.push(decodeEntities(raw))
      return
    }
    // Outside <pre>, HTML whitespace is not significant.
    const text = decodeEntities(raw).replace(/\s+/g, ' ')
    if (text.trim() === '' && (target.length === 0 || /\s$/.test(target.at(-1) ?? ''))) {
      return
    }
    target.push(escapeMarkdown(text))
  }

  while ((match = tagPattern.exec(source)) !== null) {
    pushText(source.slice(cursor, match.index))
    cursor = tagPattern.lastIndex

    const [full, rawName] = match
    const name = rawName.toLowerCase()
    const closing = full.startsWith('</')

    switch (name) {
      case 'br':
        blockBreak('\n')
        break
      case 'p':
      case 'div':
      case 'section':
        blockBreak('\n\n')
        break
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        if (tableCell) {
          tableCell.push(' ')
        } else {
          out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `)
        }
        break
      case 'strong':
      case 'b':
        sink().push('**')
        break
      case 'em':
      case 'i':
        sink().push('*')
        break
      case 'code':
        if (!inPre) {
          sink().push('`')
        }
        break
      case 'pre':
        inPre = !closing
        out.push(closing ? '\n```\n\n' : '\n\n```\n')
        break
      case 'blockquote':
        // Prefix applied on the assembled text below.
        out.push(closing ? '\n\n' : '\n\n> ')
        break
      case 'table':
        if (closing) {
          if (table) {
            out.push(`\n\n${renderGfmTable(table)}\n\n`)
          }
          table = null
          tableRow = null
          tableCell = null
          inThead = false
        } else {
          table = { rows: [], headerRowIndex: -1 }
        }
        break
      case 'thead':
        inThead = !closing
        break
      case 'tbody':
      case 'tfoot':
        break
      case 'tr':
        if (!table) {
          break
        }
        if (closing) {
          if (tableRow) {
            const index = table.rows.push(tableRow) - 1
            if ((inThead || rowHasHeaderCell) && table.headerRowIndex === -1) {
              table.headerRowIndex = index
            }
          }
          tableRow = null
          rowHasHeaderCell = false
        } else {
          tableRow = []
          rowHasHeaderCell = false
        }
        break
      case 'th':
      case 'td':
        if (!table) {
          break
        }
        if (closing) {
          if (tableCell && tableRow) {
            tableRow.push(flattenTableCell(tableCell))
          }
          tableCell = null
        } else {
          tableCell = []
          if (name === 'th') {
            rowHasHeaderCell = true
          }
        }
        break
      case 'ul':
      case 'ol':
        if (closing) {
          listStack.pop()
        } else {
          listStack.push({ ordered: name === 'ol', index: 0 })
        }
        out.push('\n')
        break
      case 'li': {
        if (closing) {
          break
        }
        const frame = listStack.at(-1)
        const indent = '  '.repeat(Math.max(0, listStack.length - 1))
        if (frame?.ordered) {
          frame.index += 1
          out.push(`\n${indent}${frame.index}. `)
        } else {
          out.push(`\n${indent}- `)
        }
        break
      }
      case 'a':
        if (closing) {
          sink().push(pendingLink ? `](${pendingLink})` : '')
          pendingLink = null
        } else {
          // Odoo mention links (`@Name`) carry a real anchor tag, but their
          // href is always "#" — rendering them as `[@Name](#)` would be
          // noise, so keep the readable "@Name" text and drop the wrapper.
          const isMentionLink =
            attribute(full, 'data-oe-model') === 'res.partner' &&
            (attribute(full, 'class') ?? '').split(/\s+/).includes('o_mail_redirect')
          const href = isMentionLink ? null : attribute(full, 'href')
          pendingLink = href
          if (href) {
            sink().push('[')
          }
        }
        break
      case 'img': {
        const src = attribute(full, 'src')
        const alt = attribute(full, 'alt') ?? ''
        if (src) {
          sink().push(`![${alt}](${src})`)
        }
        break
      }
      default:
        break
    }
  }
  pushText(source.slice(cursor))

  return collapseBlankLines(out.join(''))
}

/**
 * Converts markdown written in Orca to the HTML Odoo's chatter stores.
 *
 * Why: RPC callers cannot hand Odoo a `Markup` object, so bodies must travel as
 * HTML strings alongside `body_is_html: true`. Odoo sanitizes on write.
 *
 * Why raw HTML survives: the composer embeds real `<a data-oe-model=...>`
 * mention anchors inline in the markdown source (Odoo mentions need attributes
 * markdown can't express); `marked` passes inline/block HTML through
 * untouched by default, so those anchors reach Odoo intact.
 */
export function markdownToChatterHtml(markdown: string): string {
  if (!markdown.trim()) {
    return ''
  }
  return marked.parse(markdown, { async: false, gfm: true, breaks: true }).trim()
}
