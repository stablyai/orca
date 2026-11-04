import { describe, expect, it } from 'vitest'
import { resolvePluginModuleSpecifier } from './plugin-frame-module-resolution'
import { createPluginSourceModuleCompiler } from './plugin-frame-module-transform'
import { transpilePluginSource } from './plugin-source-transpiler'

// The real transform, in process; the worker hop is covered by plugin-source-transpile-client.
const inProcess = () =>
  createPluginSourceModuleCompiler({
    transpile: async (path, source) => transpilePluginSource(path, source)
  })

const FILES = new Set([
  'src/panel.tsx',
  'src/util.ts',
  'src/list/index.tsx',
  'src/legacy.js',
  'src/data.json',
  'src/my file.ts'
])
const exists = async (path: string) => FILES.has(path)
const encode = (text: string) => new TextEncoder().encode(text)

describe('resolvePluginModuleSpecifier', () => {
  it('refuses bare packages, escapes and missing files', async () => {
    const refuse = (specifier: string) =>
      resolvePluginModuleSpecifier('src/panel.tsx', specifier, exists)
    await expect(refuse('react')).resolves.toMatchObject({
      kind: 'refuse',
      reason: expect.stringContaining('cannot import "react"')
    })
    await expect(refuse('../../secret')).resolves.toMatchObject({
      reason: expect.stringContaining('outside the plugin')
    })
    await expect(refuse('./nope')).resolves.toMatchObject({
      reason: expect.stringContaining('no such file')
    })
  })
})

describe('createPluginSourceModuleCompiler', () => {
  it('strips types, compiles JSX for orca and rewrites relative imports, keeping lines', async () => {
    const compile = inProcess()
    const source = [
      "import { Stack, type Atom } from 'orca'",
      "import { add } from './util'",
      'type Props = { n: number }',
      'export default function Panel({ n }: Props) {',
      '  return <Stack gap="md">{add(n, 1)}</Stack>',
      '}',
      "export const later = () => import('./list')"
    ].join('\n')
    const code = await compile({ relativePath: 'src/panel.tsx', bytes: encode(source), exists })
    expect(code).toContain('from "orca/jsx-runtime"')
    expect(code).toContain("from './util.ts'")
    expect(code).toContain('import("./list/index.tsx")')
    expect(code).not.toContain('Props')
    expect(code).not.toContain('Atom')
    // Line-preserving: a guest error's line number is the author's line number.
    const lines = code.split('\n')
    expect(lines[4]).toContain('_jsx(Stack')
    const mapLine = lines.at(-2) ?? ''
    expect(mapLine).toMatch(/^\/\/# sourceMappingURL=data:application\/json/)
    const map = JSON.parse(Buffer.from(mapLine.split('base64,')[1], 'base64').toString('utf8'))
    expect(map).toMatchObject({ sources: ['panel.tsx'], sourcesContent: [source] })
  })
})
