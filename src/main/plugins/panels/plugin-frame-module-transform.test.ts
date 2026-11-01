import { describe, expect, it, vi } from 'vitest'
import { resolvePluginModuleSpecifier } from './plugin-frame-module-resolution'
import {
  createPluginSourceModuleCompiler,
  PLUGIN_SOURCE_MODULE_MAX_BYTES
} from './plugin-frame-module-transform'
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
  it.each([
    ['./util', './util.ts'],
    ['./util.js', './util.ts'],
    ['./list', './list/index.tsx'],
    ['./legacy.js', './legacy.js'],
    ['./data.json', './data.json'],
    ['../src/util', './util.ts'],
    ['/src/util', './util.ts'],
    ['./my file', './my%20file.ts'],
    ['./util?raw', './util.ts?raw']
  ])('resolves %s to %s', async (specifier, expected) => {
    await expect(resolvePluginModuleSpecifier('src/panel.tsx', specifier, exists)).resolves.toEqual(
      { kind: 'rewrite', specifier: expected }
    )
  })

  it('leaves orca and URLs to the import map and CSP', async () => {
    for (const specifier of ['orca', 'orca/jsx-runtime', 'https://cdn.example/x.js']) {
      await expect(
        resolvePluginModuleSpecifier('src/panel.tsx', specifier, exists)
      ).resolves.toEqual({ kind: 'keep' })
    }
  })

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

  it('keeps `<T>` casts working in .ts files, which are not JSX', async () => {
    const compile = inProcess()
    const code = await compile({
      relativePath: 'src/util.ts',
      bytes: encode('export const add = (a: number, b: number) => <number>(a + b)\n'),
      exists
    })
    expect(code).toContain('export const add = (a, b) => (a + b)')
  })

  it('serves a module that throws, naming file:line:column, for bare imports and syntax errors', async () => {
    const compile = inProcess()
    const bare = await compile({
      relativePath: 'src/panel.tsx',
      bytes: encode("// a panel\nimport React from 'react'\nexport default () => React\n"),
      exists
    })
    expect(bare).toMatch(/^throw new Error\("src\/panel\.tsx:2:19: cannot import \\"react\\"/)
    const broken = await compile({
      relativePath: 'src/util.ts',
      bytes: encode('const ok = 1\nexport const = 1'),
      exists
    })
    // Sucrase's "Error transforming <file>:" prefix and "(line:column)" suffix become the location.
    expect(broken).toBe('throw new Error("src/util.ts:2:14: Unexpected token")\n')
  })

  it('caches by content and transpiler, not by path alone', async () => {
    const transpile = vi.fn(async (_path: string, source: string) => ({
      ok: true as const,
      code: source,
      mappings: '',
      imports: []
    }))
    const compile = createPluginSourceModuleCompiler({ transpile })
    const input = { relativePath: 'a.ts', exists }
    await compile({ ...input, bytes: encode('one') })
    await compile({ ...input, bytes: encode('one') })
    expect(transpile).toHaveBeenCalledTimes(1)
    await compile({ ...input, bytes: encode('two') })
    expect(transpile).toHaveBeenCalledTimes(2)
    // Another transpiler version never reuses this one's output.
    const next = createPluginSourceModuleCompiler({ transpile, transpilerId: 'sucrase@99' })
    await next({ ...input, bytes: encode('one') })
    expect(transpile).toHaveBeenCalledTimes(3)
  })

  it('refuses files over the size cap without transpiling, and remembers failures', async () => {
    const transpile = vi.fn(async () => ({ ok: false as const, message: 'over budget' }))
    const compile = createPluginSourceModuleCompiler({ transpile })
    const slow = { relativePath: 'slow.ts', bytes: encode('x'), exists }
    expect(await compile(slow)).toContain('slow.ts: over budget')
    expect(await compile(slow)).toContain('slow.ts: over budget')
    expect(transpile).toHaveBeenCalledTimes(1)
    const big = await compile({
      relativePath: 'big.ts',
      bytes: new Uint8Array(PLUGIN_SOURCE_MODULE_MAX_BYTES + 1),
      exists
    })
    expect(big).toContain('source modules are capped')
    expect(transpile).toHaveBeenCalledTimes(1)
  })
})
