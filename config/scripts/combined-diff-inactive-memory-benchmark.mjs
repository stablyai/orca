// Run: node --expose-gc config/scripts/combined-diff-inactive-memory-benchmark.mjs [checkout-root]
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

assert.equal(typeof globalThis.gc, 'function', 'Run with --expose-gc')
const checkoutRoot = path.resolve(
  process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url))
)
const result = await build({
  entryPoints: [
    path.join(
      checkoutRoot,
      'src/renderer/src/components/editor/combined-diff/remember-view/combined-diff-view-cache.ts'
    )
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': path.join(checkoutRoot, 'src/renderer/src') }
})
const cache = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)
const VIEW_COUNT = 12
const SECTIONS_PER_VIEW = 4
const CHARACTERS_PER_SIDE = 750_000
const keys = []

function collectHeap() {
  for (let count = 0; count < 4; count++) {
    globalThis.gc()
  }
  return process.memoryUsage().heapUsed
}

function rememberView(index) {
  const key = `view-${index}`
  keys.push(key)
  const lease = cache.claimCombinedDiffView(key, `workspace-${index}`)
  const sections = Array.from({ length: SECTIONS_PER_VIEW }, (_, sectionIndex) => {
    // Allocate owned flat strings so forced GC measures real bodies rather than lazy repeats.
    const originalContent = Buffer.alloc(CHARACTERS_PER_SIDE, 65 + index).toString('ascii')
    const modifiedContent = Buffer.alloc(CHARACTERS_PER_SIDE, 97 + index).toString('ascii')
    return {
      key: `${sectionIndex}.txt`,
      path: `${sectionIndex}.txt`,
      status: 'modified',
      added: 1,
      removed: 1,
      originalContent,
      modifiedContent,
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: {
        kind: 'text',
        originalContent,
        modifiedContent,
        originalIsBinary: false,
        modifiedIsBinary: false
      },
      largeDiffRenderLimit: null
    }
  })
  cache.rememberCombinedDiffView(lease, {
    view: {
      entrySignature: key,
      gitStatusSignature: '',
      sections,
      sectionHeights: {},
      loadedIndices: sections.map((_, sectionIndex) => sectionIndex),
      sideBySide: true
    },
    scrollTop: 100 + index
  })
  cache.releaseCombinedDiffView(lease)
}

const initialHeap = collectHeap()
for (let index = 0; index < VIEW_COUNT; index++) {
  rememberView(index)
}
const populatedHeap = collectHeap()
let retainedCharacters = 0
let loadedSections = 0
for (const [index, key] of keys.entries()) {
  const memory = cache.readCombinedDiffViewMemory(key)
  assert.equal(memory?.scrollTop, 100 + index)
  assert.equal(memory?.view?.sections.length, SECTIONS_PER_VIEW)
  for (const section of memory.view.sections) {
    retainedCharacters += section.originalContent.length + section.modifiedContent.length
    if (!section.loading) {
      loadedSections++
    }
  }
}
console.log(
  JSON.stringify(
    {
      checkoutRoot,
      views: VIEW_COUNT,
      visitedSections: VIEW_COUNT * SECTIONS_PER_VIEW,
      retainedCharacters,
      loadedSections,
      heapDeltaBytes: populatedHeap - initialHeap,
      node: process.version,
      platform: process.platform,
      arch: process.arch
    },
    null,
    2
  )
)
