import { describe, expect, it, vi } from 'vitest'
import { buildUnitDependencyGraph } from './ci-unit-dependency-graph.mjs'

describe('unit graph import resolution', () => {
  it('avoids allocating an extension-candidate array for every resolved import', () => {
    const consumers = Array.from({ length: 1000 }, (_, index) => `src/consumer-${index}.ts`)
    const sources = new Map([
      ['src/leaf', 'export const value = 1'],
      ...consumers.map((file) => [file, "import './leaf'"])
    ])
    const originalMap = Array.prototype.map
    let extensionArrays = 0
    const spy = vi.spyOn(Array.prototype, 'map').mockImplementation(function (...args) {
      if (this.length === 10 && this[0] === '' && this[1] === '.ts' && this[9] === '/index.js') {
        extensionArrays += 1
      }
      return originalMap.apply(this, args)
    })
    try {
      const graph = buildUnitDependencyGraph(sources)
      spy.mockRestore()
      expect([...graph.reverse]).toEqual([['src/leaf', new Set(consumers)]])
      expect(graph.opaque).toEqual(new Set())
      expect(extensionArrays).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('keeps first-match precedence across literal paths, extensions and index files', () => {
    const sources = new Map([
      ['src/leaf', ''],
      ['src/leaf.ts', ''],
      ['src/leaf.tsx', ''],
      ['src/component.tsx', ''],
      ['src/component.js', ''],
      ['src/folder/index.ts', ''],
      ['src/folder/index.tsx', ''],
      ['src/config.json', '{}'],
      ['src/renderer/src/view.tsx', ''],
      ['src/use.ts', "import './leaf'; import './component'; import './folder'; import './config'"],
      ['src/aliases.ts', "import '@renderer/view'; import '@/view'; import 'external-package'"],
      ['src/missing.ts', "import './missing-file'"],
      ['src/dynamic.ts', 'import(variablePath)'],
      ['config/owner.mjs', "import '../src/leaf'"],
      ['tests/owner.ts', "import '../src/leaf'"]
    ])
    expect(buildUnitDependencyGraph(sources)).toEqual({
      reverse: new Map([
        ['src/leaf', new Set(['src/use.ts', 'config/owner.mjs', 'tests/owner.ts'])],
        ['src/component.tsx', new Set(['src/use.ts'])],
        ['src/folder/index.ts', new Set(['src/use.ts'])],
        ['src/config.json', new Set(['src/use.ts'])],
        ['src/renderer/src/view.tsx', new Set(['src/aliases.ts'])]
      ]),
      opaque: new Set(['src/missing.ts', 'src/dynamic.ts', 'config/owner.mjs', 'tests/owner.ts'])
    })
  })
})
