import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  mappedSourceFiles,
  assertMappedPatchDerivation
} from './xterm-sourcemap-source-contract.mjs'

const source = 'webpack://@xterm/xterm/./src/common/InputHandler.ts'
const makeMap = (sources, sourcesContent) => ({ sources, sourcesContent })

describe('mapped source provenance', () => {
  it('recognizes both published source namespaces', () => {
    expect(mappedSourceFiles(makeMap([source], ['source'])).get('src/common/InputHandler.ts')).toBe(
      'source'
    )
    expect(
      mappedSourceFiles(makeMap(['../../src/common/InputHandler.ts'], ['source'])).get(
        'src/common/InputHandler.ts'
      )
    ).toBe('source')
  })
  it('rejects unknown namespaces, missing content, duplicate and unsafe source paths', () => {
    expect(() => mappedSourceFiles(makeMap(['unknown/InputHandler.ts'], ['source']))).toThrow(
      /no upstream/
    )
    expect(() => mappedSourceFiles(makeMap([source], [null]))).toThrow(/Missing mapped/)
    expect(() => mappedSourceFiles(makeMap([source, source], ['a', 'a']))).toThrow(/Duplicate/)
    expect(() => mappedSourceFiles(makeMap(['../../src/../outside.ts'], ['a']))).toThrow(/Unsafe/)
  })
  it('rejects a source patch that differs from the generated map', () => {
    const root = new URL('../patches/', import.meta.url)
    const patch = readFileSync(new URL('@xterm__headless@6.1.0-beta.302.patch', root), 'utf8')
    const sourcePatch = readFileSync(
      new URL('xterm-src/@xterm__headless@6.1.0-beta.302.src.patch', root),
      'utf8'
    )
    expect(() =>
      assertMappedPatchDerivation(
        sourcePatch.replace('pos--;', 'pos -= 2;'),
        patch,
        'lib-headless/xterm-headless.js.map'
      )
    ).toThrow(/disagree/)
    const omitted = sourcePatch.replaceAll('src/common/InputHandler.ts', 'src/common/Unmapped.ts')
    expect(() =>
      assertMappedPatchDerivation(omitted, patch, 'lib-headless/xterm-headless.js.map')
    ).toThrow()
  })
})

it.each(['webpack/bootstrap', '../../src/'])(
  'rejects changed unknown source %s alongside valid sources',
  (unknown) => {
    const before = {
      version: 3,
      sources: [source, unknown],
      sourcesContent: ['a', 'unchanged']
    }
    const after = { ...before, sourcesContent: ['a', 'modified'] }
    const mapPath = 'lib-headless/xterm-headless.js.map'
    const patch = `diff --git a/${mapPath} b/${mapPath}\n--- a/${mapPath}\n+++ b/${mapPath}\n@@ -1 +1 @@\n-${JSON.stringify(before)}\n+${JSON.stringify(after)}\n`
    expect(() => assertMappedPatchDerivation('', patch, mapPath)).toThrow(
      /Unrecognized mapped source changed/
    )
  }
)
