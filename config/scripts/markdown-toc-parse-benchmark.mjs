#!/usr/bin/env node
// Benchmark: cost of the rich-markdown Table-of-Contents parse that fires on
// every debounced content change while typing.
//
// Before the fix (RichMarkdownEditor.tsx), buildMarkdownTableOfContents() ran a
// full-document remark parse on EVERY content change even when the TOC panel was
// closed (the default), then discarded the result. This benchmark mirrors that
// parse workload across document sizes and reports the main-thread time spent
// per "typing burst" so the wasted work is quantified.
//
// The fix gates the memo on showTableOfContents, so when the panel is closed the
// per-burst cost drops to ~0 (a stable empty array, no parse). This script
// measures the "panel closed" cost that the gate eliminates.
import { performance } from 'node:perf_hooks'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

const DOC_HEADINGS = Number.parseInt(process.env.ORCA_TOC_BENCH_HEADINGS ?? '400', 10)
const PARAGRAPHS_PER_HEADING = Number.parseInt(process.env.ORCA_TOC_BENCH_PARAS ?? '6', 10)
// Number of debounced content changes in a sustained typing burst. The editor
// debounces serialize at 300ms, so ~200 changes ≈ a minute of steady typing.
const CONTENT_CHANGES = Number.parseInt(process.env.ORCA_TOC_BENCH_CHANGES ?? '200', 10)
const WARMUP = Number.parseInt(process.env.ORCA_TOC_BENCH_WARMUP ?? '5', 10)

for (const [name, value] of [
  ['ORCA_TOC_BENCH_HEADINGS', DOC_HEADINGS],
  ['ORCA_TOC_BENCH_PARAS', PARAGRAPHS_PER_HEADING],
  ['ORCA_TOC_BENCH_CHANGES', CONTENT_CHANGES],
  ['ORCA_TOC_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

// Mirror of buildMarkdownTableOfContents()'s parse + heading walk
// (src/renderer/src/components/editor/markdown-table-of-contents.ts). Kept inline
// so the benchmark exercises the real remark pipeline without bundling the TS.
function buildMarkdownTableOfContentsLike(markdown) {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml', 'toml'])
    .parse(markdown)
  const headings = []
  const visit = (node) => {
    if (node.type === 'heading' && typeof node.depth === 'number') {
      let title = ''
      const collect = (n) => {
        if (typeof n.value === 'string') {
          title += n.value
        }
        for (const child of n.children ?? []) {
          collect(child)
        }
      }
      collect(node)
      if (title) {
        headings.push({ depth: node.depth, title })
      }
    }
    for (const child of node.children ?? []) {
      visit(child)
    }
  }
  visit(tree)
  return headings
}

function buildDocument(headings, parasPerHeading) {
  const lines = ['---', 'title: Benchmark Document', 'tags: [perf, toc]', '---', '']
  for (let h = 0; h < headings; h += 1) {
    const level = (h % 3) + 1
    lines.push(`${'#'.repeat(level)} Section ${h} \`code\` **bold** [link](https://example.com)`)
    lines.push('')
    for (let p = 0; p < parasPerHeading; p += 1) {
      lines.push(
        `Paragraph ${p} for section ${h} with *emphasis*, \`inline code\`, and ` +
          'some filler text to give the parser realistic body content to walk over.'
      )
      lines.push('')
    }
    if (h % 5 === 0) {
      lines.push('| Col A | Col B | Col C |', '| --- | --- | --- |', '| 1 | 2 | 3 |', '')
    }
  }
  return lines.join('\n')
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function measureDoc(headings, parasPerHeading) {
  const baseDoc = buildDocument(headings, parasPerHeading)
  // Simulate typing: each content change appends one character so `content`
  // changes identity every time (matching the memo dependency in the editor).
  const perChange = []
  for (let i = 0; i < WARMUP + CONTENT_CHANGES; i += 1) {
    const doc = `${baseDoc}\nedit-${i}`
    const t0 = performance.now()
    const toc = buildMarkdownTableOfContentsLike(doc)
    const elapsed = performance.now() - t0
    if (i >= WARMUP) {
      perChange.push(elapsed)
    }
    if (toc.length === 0) {
      throw new Error('benchmark produced an empty TOC; document generation is broken')
    }
  }
  const total = perChange.reduce((sum, value) => sum + value, 0)
  return {
    bytes: Buffer.byteLength(baseDoc, 'utf8'),
    headings,
    perChangeMedianMs: median(perChange),
    perChangeMaxMs: Math.max(...perChange),
    burstTotalMs: total
  }
}

const sizes = [
  { headings: Math.round(DOC_HEADINGS / 8), paras: PARAGRAPHS_PER_HEADING },
  { headings: Math.round(DOC_HEADINGS / 2), paras: PARAGRAPHS_PER_HEADING },
  { headings: DOC_HEADINGS, paras: PARAGRAPHS_PER_HEADING }
]

console.log('Markdown TOC parse benchmark (cost incurred per content change while typing)')
console.log(
  `changes/burst=${CONTENT_CHANGES} warmup=${WARMUP} paras/heading=${PARAGRAPHS_PER_HEADING}\n`
)
console.log(
  '  doc size │ headings │ per-change median │ per-change max │ burst total (closed-panel waste)'
)
console.log(
  '  ─────────┼──────────┼───────────────────┼────────────────┼──────────────────────────────────'
)
for (const size of sizes) {
  const result = measureDoc(size.headings, size.paras)
  const kib = (result.bytes / 1024).toFixed(0).padStart(5)
  const headingsCol = String(result.headings).padStart(8)
  const med = `${result.perChangeMedianMs.toFixed(2)} ms`.padStart(17)
  const max = `${result.perChangeMaxMs.toFixed(2)} ms`.padStart(14)
  const burst = `${result.burstTotalMs.toFixed(0)} ms`.padStart(10)
  console.log(`  ${kib} KiB │ ${headingsCol} │ ${med} │ ${max} │ ${burst}`)
}
console.log(
  '\nWith the fix, every row above costs ~0 ms while the TOC panel is closed' +
    ' (the default state): the parse is skipped and a stable empty array is returned.'
)
