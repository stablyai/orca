// A Google Doc's structure as text: headings, lists and tables kept as Markdown, open suggestions
// marked inline, and the doc's exact text with its positions, so edits name text instead of indexes.
import { z } from 'zod'
import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'

type TextRun = {
  content?: string
  suggestedInsertionIds?: string[]
  suggestedDeletionIds?: string[]
}
type Element = {
  startIndex?: number
  endIndex?: number
  paragraph?: {
    elements?: { startIndex?: number; textRun?: TextRun }[]
    paragraphStyle?: { namedStyleType?: string }
    bullet?: { listId?: string; nestingLevel?: number }
  }
  table?: { tableRows?: { tableCells?: { content?: Element[] }[] }[] }
}
const ElementSchema: z.ZodType<Element> = lazyZodSchema(() =>
  z.lazy(() =>
    z.object({
      startIndex: z.number().optional(),
      endIndex: z.number().optional(),
      paragraph: z
        .object({
          elements: z
            .array(
              z.object({
                startIndex: z.number().optional(),
                textRun: z
                  .object({
                    content: z.string().optional(),
                    suggestedInsertionIds: z.array(z.string()).optional(),
                    suggestedDeletionIds: z.array(z.string()).optional()
                  })
                  .optional()
              })
            )
            .optional(),
          paragraphStyle: z.object({ namedStyleType: z.string().optional() }).optional(),
          bullet: z
            .object({ listId: z.string().optional(), nestingLevel: z.number().optional() })
            .optional()
        })
        .optional(),
      table: z
        .object({
          tableRows: z
            .array(
              z.object({
                tableCells: z
                  .array(z.object({ content: z.array(ElementSchema).optional() }))
                  .optional()
              })
            )
            .optional()
        })
        .optional()
    })
  )
)
const Segment = lazyZodSchema(() => z.object({ content: z.array(ElementSchema).default([]) }))
const DocumentTabSchema = lazyZodSchema(() =>
  z.object({
    body: Segment.optional(),
    headers: z.record(z.string(), Segment).optional(),
    footers: z.record(z.string(), Segment).optional(),
    footnotes: z.record(z.string(), Segment).optional(),
    lists: z
      .record(
        z.string(),
        z.object({
          listProperties: z
            .object({
              nestingLevels: z.array(z.object({ glyphType: z.string().optional() })).optional()
            })
            .optional()
        })
      )
      .optional()
  })
)
type Tab = {
  tabProperties?: { tabId?: string; title?: string }
  documentTab?: z.infer<typeof DocumentTabSchema>
  childTabs?: Tab[]
}
const TabSchema: z.ZodType<Tab> = lazyZodSchema(() =>
  z.lazy(() =>
    z.object({
      tabProperties: z
        .object({ tabId: z.string().optional(), title: z.string().optional() })
        .optional(),
      documentTab: DocumentTabSchema.optional(),
      childTabs: z.array(TabSchema).optional()
    })
  )
)
export const DocumentSchema = lazyZodSchema(() =>
  z.object({
    documentId: z.string(),
    title: z.string().default(''),
    tabs: z.array(TabSchema).default([]),
    body: Segment.optional()
  })
)
export type GoogleDocument = z.infer<typeof DocumentSchema>

/** Every tab, children after their parent, as one list. */
export function flatTabs(doc: GoogleDocument): Tab[] {
  const all: Tab[] = []
  const walk = (tabs: Tab[]) => {
    for (const tab of tabs) {
      all.push(tab)
      walk(tab.childTabs ?? [])
    }
  }
  walk(doc.tabs.length ? doc.tabs : [{ documentTab: { body: doc.body } }])
  return all
}

const NUMBERED = /DECIMAL|ALPHA|ROMAN/

/** The doc as Markdown-like text, and how many open suggestions it has. */
export function renderDocument(doc: GoogleDocument): { text: string; suggestions: number } {
  const suggestions = new Set<string>()
  const tabs = flatTabs(doc)
  const parts = tabs.map((tab) => {
    const lists = tab.documentTab?.lists ?? {}
    const runText = (run: TextRun) => {
      const content = (run.content ?? '').replace(/\n$/, '')
      for (const id of [
        ...(run.suggestedInsertionIds ?? []),
        ...(run.suggestedDeletionIds ?? [])
      ]) {
        suggestions.add(id)
      }
      return run.suggestedDeletionIds?.length
        ? `[-${content}-]`
        : run.suggestedInsertionIds?.length
          ? `[+${content}+]`
          : content
    }
    const paragraphText = (element: Element) =>
      (element.paragraph?.elements ?? [])
        .map((part) => (part.textRun ? runText(part.textRun) : ''))
        .join('')
        .replaceAll(String.fromCharCode(11), '\n')
    const render = (content: Element[]): string[] =>
      content.flatMap((element) => {
        if (element.table) {
          const rows = (element.table.tableRows ?? []).map(
            (row) =>
              `| ${(row.tableCells ?? [])
                .map((cell) =>
                  render(cell.content ?? [])
                    .join(' ')
                    .replace(/\|/g, '\\|')
                )
                .join(' | ')} |`
          )
          const width = (element.table.tableRows?.[0]?.tableCells ?? []).length
          return rows.length ? [rows[0] ?? '', `|${' --- |'.repeat(width)}`, ...rows.slice(1)] : []
        }
        if (!element.paragraph) {
          return []
        }
        const text = paragraphText(element)
        const style = element.paragraph.paragraphStyle?.namedStyleType ?? ''
        const heading = /^HEADING_(\d)$/.exec(style)?.[1]
        const bullet = element.paragraph.bullet
        if (bullet) {
          const level = bullet.nestingLevel ?? 0
          const glyph =
            lists[bullet.listId ?? '']?.listProperties?.nestingLevels?.[level]?.glyphType
          return [`${'  '.repeat(level)}${glyph && NUMBERED.test(glyph) ? '1.' : '-'} ${text}`]
        }
        return [
          heading
            ? `${'#'.repeat(Number(heading))} ${text}`
            : style === 'TITLE'
              ? `# ${text}`
              : text
        ]
      })
    const body = render(tab.documentTab?.body?.content ?? []).join('\n')
    const title = tab.tabProperties?.title
    return tabs.length > 1 && title ? `=== Tab: ${title} ===\n${body}` : body
  })
  return {
    text: parts
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    suggestions: suggestions.size
  }
}

/** A stretch of the doc's exact text and the doc position of each of its characters. */
export type DocText = { tabId?: string; text: string; at: number[]; body: boolean }

/** The exact text of every body, header, footer and footnote, as Google matches against it. */
export function documentTexts(doc: GoogleDocument): DocText[] {
  const texts: DocText[] = []
  for (const tab of flatTabs(doc)) {
    const tabId = tab.tabProperties?.tabId
    const segments = [
      { content: tab.documentTab?.body?.content ?? [], body: true },
      ...[tab.documentTab?.headers, tab.documentTab?.footers, tab.documentTab?.footnotes].flatMap(
        (group) =>
          Object.values(group ?? {}).map((segment) => ({ content: segment.content, body: false }))
      )
    ]
    for (const segment of segments) {
      const collect = (content: Element[]) => {
        for (const element of content) {
          for (const row of element.table?.tableRows ?? []) {
            for (const cell of row.tableCells ?? []) {
              collect(cell.content ?? [])
            }
          }
          const found: DocText = {
            ...(tabId ? { tabId } : {}),
            text: '',
            at: [],
            body: segment.body
          }
          for (const part of element.paragraph?.elements ?? []) {
            const content = part.textRun?.content ?? ''
            found.text += content
            for (let i = 0; i < content.length; i++) {
              found.at.push((part.startIndex ?? 0) + i)
            }
          }
          if (found.text) {
            texts.push(found)
          }
        }
      }
      collect(segment.content)
    }
  }
  return texts
}

/** Where `needle` occurs in the doc's paragraphs, without overlaps. */
export function findInDocument(
  texts: DocText[],
  needle: string,
  matchCase: boolean
): { text: DocText; start: number }[] {
  const fold = (value: string) => (matchCase ? value : value.toLowerCase())
  const wanted = fold(needle)
  const found: { text: DocText; start: number }[] = []
  for (const text of texts) {
    const haystack = fold(text.text)
    for (
      let at = haystack.indexOf(wanted);
      at >= 0;
      at = haystack.indexOf(wanted, at + wanted.length)
    ) {
      found.push({ text, start: at })
    }
  }
  return found
}
