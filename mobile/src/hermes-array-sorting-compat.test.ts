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
const UNSUPPORTED_ARRAY_SORTING = /\.toSorted\s*\(/

function usesUnsupportedArraySorting(source: string): boolean {
  if (!UNSUPPORTED_ARRAY_SORTING.test(source)) {
    return false
  }
  const decommented = stripComments(source)
  return (
    blankStringContentsDesynced(decommented) ||
    UNSUPPORTED_ARRAY_SORTING.test(blankStringContents(decommented))
  )
}

function findUnsupportedArraySorting(files: readonly ScannedFile[]): string[] {
  return files
    .filter((file) => !isTestFile(file.relativePath))
    .filter((file) => usesUnsupportedArraySorting(file.source))
    .map((file) => file.relativePath)
}

describe('Hermes array sorting compatibility', () => {
  it('detects live copied-array sorting while ignoring inert text and tests', () => {
    expect(
      findUnsupportedArraySorting([
        { path: 'live.ts', relativePath: 'live.ts', source: 'const sorted = items.toSorted()' },
        {
          path: 'inert.ts',
          relativePath: 'inert.ts',
          source: "// items.toSorted()\nconst example = 'items.toSorted()'"
        },
        {
          path: 'allowed.test.ts',
          relativePath: 'allowed.test.ts',
          source: 'items.toSorted()'
        }
      ])
    ).toEqual(['live.ts'])
  })

  it('keeps production mobile bundle sources free of unsupported copied-array sorting', () => {
    const offenders = SOURCE_ROOTS.flatMap(({ label, path }) =>
      findUnsupportedArraySorting(scanSourceTree(path, { includeTests: true })).map(
        (relativePath) => `${label}/${relativePath}`
      )
    )

    expect(offenders).toEqual([])
  })
})
