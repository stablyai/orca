import { describe, expect, it } from 'vitest'
import { compiledOperationModule } from './compiled-operation-module'

describe('compiled operation code', () => {
  it('reuses identical code but separates source, exposure and diagnostic filename', () => {
    const source = 'const value: number = 1; export const read = () => value'
    const original = compiledOperationModule('original.ts', source, '')
    expect(compiledOperationModule('original.ts', source, '')).toBe(original)
    expect(compiledOperationModule('original.ts', source.replace('= 1', '= 2'), '')).not.toBe(
      original
    )
    expect(compiledOperationModule('original.ts', source, '\nexports.extra = value')).not.toBe(
      original
    )
    expect(compiledOperationModule('different.ts', source, '')).not.toBe(original)
  })

  it('bounds retained code and still evaluates an evicted module correctly', () => {
    const source = 'export const value = 42'
    const original = compiledOperationModule('evicted.ts', source, '')
    for (let index = 0; index < 512; index++) {
      compiledOperationModule(`bounded-${index}.ts`, 'export {}', '')
    }
    const recompiled = compiledOperationModule('evicted.ts', source, '')
    expect(recompiled).not.toBe(original)
    const exports = {}
    recompiled(() => undefined, exports)
    expect(exports).toEqual({ value: 42 })
  })
})
