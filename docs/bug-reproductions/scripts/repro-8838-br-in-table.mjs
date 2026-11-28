/**
 * Issue #8838 — check whether <br> in GFM table cells becomes real <br> elements
 * under the MarkdownPreview-like pipeline.
 *
 * Run: pnpm exec node --input-type=module docs/bug-reproductions/scripts/repro-8838-br-in-table.mjs
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'

const SAMPLE = `| Field | Type | Description |
|-------|------|-------------|
| verdict | string | Inspection verdict. Possible values:<br/><br/>\`normal\` - Normal. No defect found<br>\`uncertain\` - Needs review<br>\`defect\` - Defective |`

const schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary', 'kbd', 'sub', 'sup', 'ins']
}

const html = renderToStaticMarkup(
  createElement(
    Markdown,
    {
      remarkPlugins: [remarkGfm, remarkBreaks],
      rehypePlugins: [rehypeRaw, [rehypeSanitize, schema]]
    },
    SAMPLE
  )
)

const brCount = (html.match(/<br/gi) || []).length
const escaped = (html.match(/&lt;br/gi) || []).length

console.log('HTML:', html)
console.log('brCount:', brCount)
console.log('escapedBrCount:', escaped)

if (brCount > 0 && escaped === 0) {
  console.log('STATUS=NOT_REPRODUCED')
  process.exit(0)
}

console.log('STATUS=REPRODUCED')
process.exit(1)
