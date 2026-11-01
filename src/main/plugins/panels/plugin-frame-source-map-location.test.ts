import { describe, expect, it } from 'vitest'
import { describePluginError } from '../../../shared/plugins/declarative/runtime/declarative-error-location'
import { registerPluginSourceMap } from '../../../shared/plugins/declarative/runtime/declarative-source-maps'
import { pluginSourceMapPrelude } from '../../../shared/plugins/frames/plugin-frame-source-map-prelude'
import { createPluginSourceModuleCompiler } from './plugin-frame-module-transform'
import { transpilePluginSource } from './plugin-source-transpiler'

const base = 'orca-plugin-frame://0123456789abcdef/'
const encode = (text: string) => new TextEncoder().encode(text)

/** 1-based line and column of the first `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const before = text.slice(0, text.indexOf(needle))
  return { line: before.split('\n').length, column: before.length - before.lastIndexOf('\n') }
}

describe('guest error locations from served plugin modules', () => {
  // `orca plugin check` reports source positions (Node --enable-source-maps); the guest must too.
  it.each([
    ['a later line', 4],
    ['line 1, behind the prelude', 1]
  ])('maps a Chromium stack position on %s back to the source column', async (_label, line) => {
    const lines = [
      "import { Stack } from 'orca'",
      'type P = { label?: string }',
      'export default function Panel({ label }: P) {',
      '  return <Stack gap="md">{String(label)}</Stack>',
      '}'
    ]
    const thrower = "const n: number = Number('1'); if (n) throw new Error('boom')"
    lines.splice(line - 1, 0, thrower)
    const source = lines.join('\n')
    const compile = createPluginSourceModuleCompiler({
      transpile: async (path, text) => transpilePluginSource(path, text)
    })
    const code = await compile({
      relativePath: 'src/panel.tsx',
      bytes: encode(source),
      exists: async () => true
    })
    const transpiled = transpilePluginSource('src/panel.tsx', source)
    if (!transpiled.ok) {
      throw new Error(transpiled.message)
    }
    expect(code.startsWith(pluginSourceMapPrelude(transpiled.mappings))).toBe(true)
    const url = `${base}src/panel.tsx?rev=${line}`
    registerPluginSourceMap(url, transpiled.mappings)
    const generated = positionOf(code, 'new Error')
    const original = positionOf(source, 'new Error')
    // Types removed: Chromium's column is not the author's.
    expect(generated.column).not.toBe(original.column)
    const error = Object.assign(new Error('boom'), {
      stack: `Error: boom\n    at Panel (${url}:${generated.line}:${generated.column})`
    })
    expect(describePluginError(error, base)).toBe(
      `src/panel.tsx:${original.line}:${original.column}: boom`
    )
  })
})
