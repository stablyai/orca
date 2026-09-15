import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blankStringContents,
  blankStringContentsDesynced,
  isTestFile,
  scanSourceTree,
  stripComments,
  type ScannedFile
} from '../../src/shared/source-scan/source-tree-scan'

const SOURCE_ROOTS = [
  { label: 'mobile/src', path: import.meta.dirname },
  { label: 'mobile/app', path: resolve(import.meta.dirname, '../app') },
  { label: 'src/shared', path: resolve(import.meta.dirname, '../../src/shared') }
]
// anti-slop/no-array-filter-map steers `xs.filter(p).map(f)` toward the lazy
// `xs.values().filter(p).map(f).toArray()` shape, which Hermes cannot run.
const UNSUPPORTED_ITERATOR_HELPERS =
  /\.values\s*\(\s*\)\s*\.\s*(?:filter|map|flatMap|take|drop|reduce)\s*\(|\.toArray\s*\(\s*\)/

function usesUnsupportedIteratorHelpers(source: string): boolean {
  if (!UNSUPPORTED_ITERATOR_HELPERS.test(source)) {
    return false
  }
  const decommented = stripComments(source)
  return (
    blankStringContentsDesynced(decommented) ||
    UNSUPPORTED_ITERATOR_HELPERS.test(blankStringContents(decommented))
  )
}

function findUnsupportedIteratorHelpers(files: readonly ScannedFile[]): string[] {
  return files
    .values()
    .filter((file) => !isTestFile(file.relativePath))
    .filter((file) => usesUnsupportedIteratorHelpers(file.source))
    .map((file) => file.relativePath)
    .toArray()
}

describe('Hermes iterator helper compatibility', () => {
  it('detects live iterator helper pipelines while ignoring inert text and tests', () => {
    expect(
      findUnsupportedIteratorHelpers([
        {
          path: 'live.ts',
          relativePath: 'live.ts',
          source: 'const out = items.values().filter(Boolean).map(String).toArray()'
        },
        {
          path: 'inert.ts',
          relativePath: 'inert.ts',
          source: "// items.values().map(f).toArray()\nconst example = 'items.toArray()'"
        },
        {
          path: 'allowed.test.ts',
          relativePath: 'allowed.test.ts',
          source: 'items.values().map(String).toArray()'
        }
      ])
    ).toEqual(['live.ts'])
  })

  it('keeps production mobile bundle sources free of unsupported iterator helpers', () => {
    const offenders = SOURCE_ROOTS.flatMap(({ label, path }) =>
      findUnsupportedIteratorHelpers(scanSourceTree(path, { includeTests: true })).map(
        (relativePath) => `${label}/${relativePath}`
      )
    )

    expect(offenders).toEqual([])
  })
})
