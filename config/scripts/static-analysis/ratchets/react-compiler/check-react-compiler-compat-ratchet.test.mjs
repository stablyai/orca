import { describe, expect, it } from 'vitest'
import { parseListedFiles } from '../../../../build-plugins/react-compiler-uncompiled-files.mjs'
import { findStaleUncompiledFiles } from './check-react-compiler-compat-ratchet.mjs'

describe('uncompiled file list', () => {
  it('reads paths from list, count and hazard lines, dropping notes', () => {
    const text = [
      '# header',
      'src/renderer/src/a.tsx',
      'src/renderer/src/b.tsx   # why it stays uncompiled',
      '2 src/renderer/src/c.ts',
      '1 src/renderer/src/d.ts#useD:store-read-in-memo-block',
      ''
    ].join('\n')
    expect(parseListedFiles(text)).toEqual([
      'src/renderer/src/a.tsx',
      'src/renderer/src/b.tsx',
      'src/renderer/src/c.ts',
      'src/renderer/src/d.ts'
    ])
  })

  it('reports listed paths that no longer name a renderer file', () => {
    const files = new Set([
      'src/renderer/src/kept.tsx',
      'src/renderer/src/notification-test-delivery.ts'
    ])
    expect(
      findStaleUncompiledFiles(
        new Set([
          'src/renderer/src/kept.tsx',
          'src/renderer/src/notification-test-delivery.ts',
          'src/renderer/src/renamed.tsx'
        ]),
        (rel) => files.has(rel)
      )
    ).toEqual(['src/renderer/src/renamed.tsx'])
  })
})
