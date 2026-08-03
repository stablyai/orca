import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The recorder writes traces that the fixture schema has to be able to hold. The two
// live in different languages and different build graphs, so nothing but this checks
// that a field one of them learns about ever reaches the other.

const scriptsDir = import.meta.dirname
const projectDir = path.resolve(scriptsDir, '../..')

const recorderSource = readFileSync(path.join(scriptsDir, 'record-ime-trace.mjs'), 'utf8')
const schemaSource = readFileSync(
  path.join(projectDir, 'src/renderer/src/lib/ime-composition-trace.test-fixtures.ts'),
  'utf8'
)

function declaredSchemaFields(typeName) {
  const body = schemaSource.match(new RegExp(`export type ${typeName} = [^{]*\\{([^}]*)\\}`))?.[1]
  if (!body) {
    throw new Error(`${typeName} not found in the fixture schema`)
  }
  return new Set(Array.from(body.matchAll(/^\s{2}(\w+)\??:/gm), (match) => match[1]))
}

describe('record-ime-trace', () => {
  it('captures nothing the trace schema cannot express', () => {
    const captured = new Set(Array.from(recorderSource.matchAll(/entry\.(\w+) =/g), (m) => m[1]))
    const expressible = new Set([
      ...declaredSchemaFields('ImeTraceKeyEvent'),
      ...declaredSchemaFields('ImeTraceInputEvent'),
      ...declaredSchemaFields('ImeTraceCompositionEvent')
    ])

    expect(captured.size).toBeGreaterThan(0)
    expect([...captured].filter((field) => !expressible.has(field))).toEqual([])
  })

  it('records the fields the platform quirks are recognised by', () => {
    // repeat distinguishes a held key from the first press, which is the only signal
    // a macOS press-and-hold accent panel produces; selectionDirection is the only way
    // a backward preedit range survives as anything but a caret.
    expect(recorderSource).toMatch(/entry\.repeat = event\.repeat/)
    expect(recorderSource).toMatch(/selectionDirection: target\.selectionDirection/)
    expect(declaredSchemaFields('ImeTraceKeyEvent')).toContain('repeat')
    expect(declaredSchemaFields('ImeTraceTargetState')).toContain('selectionDirection')
  })

  it('carries an undefined isComposing as null rather than dropping the key', () => {
    // JSON.stringify omits undefined-valued keys outright, so coercing here would
    // erase the one bit a Safari trace is recorded to preserve.
    expect(recorderSource).toMatch(/entry\.isComposing = event\.isComposing \?\? null/)
    expect(JSON.stringify({ isComposing: undefined })).toBe('{}')
  })
})
