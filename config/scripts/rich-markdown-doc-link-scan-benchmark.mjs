#!/usr/bin/env node
// Measures the complete ProseMirror doc traversal used by the two doc-link plugins.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Schema } from '@tiptap/pm/model'
import {
  canHoldDocLink,
  DOC_LINK_PATTERN,
  isDocLinkLiteralCodeTextNode
} from '../../src/renderer/src/components/editor/rich-markdown-doc-link-scan.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITERATIONS = Number(process.env.ORCA_DOC_LINK_BENCH_ITERATIONS ?? '41')
const WARMUP_ITERATIONS = Math.min(9, ITERATIONS)

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_DOC_LINK_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*' },
    text: { group: 'inline' }
  }
})

function walkUngated(doc) {
  let matches = 0
  let visited = 0
  doc.descendants((node, _pos, parent) => {
    visited += 1
    if (node.type.name !== 'text' || !node.text || isDocLinkLiteralCodeTextNode(node, parent)) {
      return
    }
    for (const _match of node.text.matchAll(DOC_LINK_PATTERN)) {
      matches += 1
    }
  })
  return { matches, visited }
}

function walkGated(doc) {
  let matches = 0
  let visited = 0
  doc.descendants((node, _pos, parent) => {
    visited += 1
    if (!canHoldDocLink(node, parent)) {
      return
    }
    for (const _match of node.text.matchAll(DOC_LINK_PATTERN)) {
      matches += 1
    }
  })
  return { matches, visited }
}

function countMatches(source) {
  let matches = 0
  for (const _match of source.matchAll(DOC_LINK_PATTERN)) {
    matches += 1
  }
  return matches
}

function loadDocs() {
  const files = execFileSync('git', ['ls-files', '*.md', 'docs/*.md'], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024
  })
    .toString()
    .split('\n')
    .filter(Boolean)
  const docs = []
  for (const file of files) {
    try {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      const lines = source.split('\n').filter(Boolean)
      if (lines.length > 0) {
        docs.push({ file, lines, size: source.length, matches: countMatches(source) })
      }
    } catch {
      // Indexed paths can disappear while the benchmark is running.
    }
  }
  return docs
}

function createFixture(doc, nonce) {
  const paragraphs = doc.lines.map((line, index) => {
    const text = index === 0 ? `${line} bench-${nonce}` : line
    return schema.node('paragraph', null, text ? schema.text(text) : undefined)
  })
  return schema.node('doc', null, paragraphs)
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function measureCorpus(docs) {
  const samples = { ungated: [], gated: [] }
  const totals = {
    ungated: { matches: 0, visited: 0 },
    gated: { matches: 0, visited: 0 }
  }
  const seenFixtures = new WeakSet()
  let expectedMatches = 0
  let expectedVisited = 0
  const measuredOrder = []

  for (let round = -WARMUP_ITERATIONS; round < ITERATIONS; round += 1) {
    const doc = docs[(round + WARMUP_ITERATIONS) % docs.length]
    const measured = round >= 0
    const order =
      (round + WARMUP_ITERATIONS) % 2 === 0 ? ['ungated', 'gated'] : ['gated', 'ungated']
    const fixtures = {
      ungated: createFixture(doc, String(round)),
      gated: createFixture(doc, String(round))
    }

    for (const arm of order) {
      const fixture = fixtures[arm]
      if (seenFixtures.has(fixture)) {
        throw new Error('timed fixture was reused')
      }
      seenFixtures.add(fixture)
      const start = performance.now()
      const result = arm === 'ungated' ? walkUngated(fixture) : walkGated(fixture)
      const elapsed = performance.now() - start
      if (measured) {
        samples[arm].push(elapsed)
        totals[arm].matches += result.matches
        totals[arm].visited += result.visited
        measuredOrder.push(arm)
      }
    }
    if (measured) {
      expectedMatches += doc.matches
      expectedVisited += doc.lines.length * 2
    }
  }

  if (totals.ungated.matches !== expectedMatches || totals.gated.matches !== expectedMatches) {
    throw new Error(
      `gate changed matches: expected ${expectedMatches}, ungated ${totals.ungated.matches}, gated ${totals.gated.matches}`
    )
  }
  if (totals.ungated.visited !== expectedVisited || totals.gated.visited !== expectedVisited) {
    throw new Error(
      `full traversal result was not consumed: expected ${expectedVisited}, ungated ${totals.ungated.visited}, gated ${totals.gated.visited}`
    )
  }
  for (let index = 0; index < measuredOrder.length; index += 2) {
    const pair = measuredOrder.slice(index, index + 2).join(',')
    const previousPair = index === 0 ? null : measuredOrder.slice(index - 2, index).join(',')
    if (!['ungated,gated', 'gated,ungated'].includes(pair) || pair === previousPair) {
      throw new Error('benchmark arms were not interleaved in alternating order')
    }
  }

  return { ungated: median(samples.ungated), gated: median(samples.gated) }
}

const docs = loadDocs()
if (docs.length === 0) {
  throw new Error('no markdown files found in the index')
}
const large = docs.filter((doc) => doc.size > 3000)
const biggest = docs.reduce((a, b) => (b.size > a.size ? b : a))
const pad = (value, width) => String(value).padStart(width)

console.log('Doc-link ProseMirror traversal, per editor transaction. Lower is better.')
console.log(
  `docs=${docs.length} (>3KB: ${large.length}) iterations=${ITERATIONS} (interleaved median)`
)
console.log(
  `${pad('corpus', 26)} ${pad('ungated', 11)} ${pad('gated', 11)} ${pad('delta', 11)} ${pad('speedup', 9)}`
)

for (const [label, set] of [
  ['all repo markdown', docs],
  ['docs over 3 KB', large],
  [`biggest (${biggest.file.split('/').pop()})`, [biggest]]
]) {
  if (set.length === 0) {
    console.log(`${pad(label, 26)} ${pad('no docs in this corpus — skipped', 44)}`)
    continue
  }
  const { ungated, gated } = measureCorpus(set)
  const delta = ungated - gated
  console.log(
    `${pad(label, 26)} ${pad(`${(ungated * 1000).toFixed(1)} us`, 11)} ${pad(`${(gated * 1000).toFixed(1)} us`, 11)} ${pad(`${(delta * 1000).toFixed(1)} us`, 11)} ${pad(`${(ungated / gated).toFixed(2)}x`, 9)}`
  )
}
console.log(
  '\nAuto-conversion pays this once per keystroke; preview decorations pay it once\nper keystroke and once per caret move.'
)
