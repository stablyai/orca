import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginWorkerSourceHooks } from './plugin-worker-source-hooks'

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-worker-source-hooks-'))
  await mkdir(join(root, 'lib', 'store'), { recursive: true })
  await writeFile(join(root, 'main.ts'), 'export default () => {}\n')
  await writeFile(join(root, 'lib', 'util.ts'), 'export const x: number = 1\n')
  await writeFile(join(root, 'lib', 'plain.js'), 'export const y = 2\n')
  await writeFile(join(root, 'lib', 'store', 'index.ts'), 'export {}\n')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Node's ESM resolver for relative files: exact paths only, a missing file throws. */
const nodeResolve = vi.fn((specifier: string, context?: { parentURL?: string }) => {
  if (specifier.startsWith('node:')) {
    return { url: specifier }
  }
  const url = new URL(specifier, context?.parentURL)
  const path = fileURLToPath(url)
  if (existsSync(path) && statSync(path).isFile()) {
    return { url: url.href }
  }
  throw Object.assign(new Error(`Cannot find module ${path}`), { code: 'ERR_MODULE_NOT_FOUND' })
})

function resolveFrom(parent: string, specifier: string): string {
  const hooks = createPluginWorkerSourceHooks(root)
  const parentURL = pathToFileURL(join(root, parent)).href
  return hooks.resolve(specifier, { conditions: [], importAttributes: {}, parentURL }, nodeResolve)
    .url
}

const fileUrl = (relativePath: string): string =>
  pathToFileURL(join(root, ...relativePath.split('/'))).href

describe('plugin worker resolve hook', () => {
  it('resolves TypeScript-style relative imports like frames do', () => {
    expect(resolveFrom('main.ts', './lib/util')).toBe(fileUrl('lib/util.ts'))
    expect(resolveFrom('main.ts', './lib/util.js')).toBe(fileUrl('lib/util.ts'))
    expect(resolveFrom('main.ts', './lib/store')).toBe(fileUrl('lib/store/index.ts'))
    expect(resolveFrom('lib/store/index.ts', '../plain')).toBe(fileUrl('lib/plain.js'))
  })

  it('leaves what Node resolves itself untouched', () => {
    expect(resolveFrom('main.ts', './lib/plain.js')).toBe(fileUrl('lib/plain.js'))
    expect(resolveFrom('main.ts', 'node:fs')).toBe('node:fs')
  })

  it('keeps the not-found error for a missing file', () => {
    expect(() => resolveFrom('main.ts', './lib/missing')).toThrow(/Cannot find module/)
  })

  it('explains that orca/worker is types only when imported as a value', () => {
    expect(() => resolveFrom('main.ts', 'orca/worker')).toThrow(
      /"orca\/worker" at run time: it only provides types/
    )
  })

  it('does not touch imports from files outside the plugin', () => {
    const hooks = createPluginWorkerSourceHooks(root)
    const parentURL = pathToFileURL(join(tmpdir(), 'host.js')).href
    expect(() =>
      hooks.resolve('orca/worker', { conditions: [], importAttributes: {}, parentURL }, nodeResolve)
    ).toThrow(/Cannot find module/)
  })
})

describe('plugin worker load hook', () => {
  const context = { conditions: [], format: undefined, importAttributes: {} }
  const nodeLoad = vi.fn(() => ({ format: 'module', source: 'node' }))

  it('transpiles .ts as an ES module, erasing type-only orca imports and keeping lines', async () => {
    await writeFile(
      join(root, 'main.ts'),
      [
        "import type { OrcaWorkerApi } from 'orca/worker'",
        "import { type PluginDisposable } from 'orca/worker'",
        'export default function activate(orca: OrcaWorkerApi): PluginDisposable | void {',
        "  throw new Error('line four')",
        '}',
        ''
      ].join('\n')
    )
    const result = createPluginWorkerSourceHooks(root).load(fileUrl('main.ts'), context, nodeLoad)
    expect(result.format).toBe('module')
    const code = String(result.source)
    expect(code).not.toContain('orca/worker')
    expect(code).not.toContain('OrcaWorkerApi')
    expect(code.split('\n')[3]).toContain("throw new Error('line four')")
    expect(code).toContain('sourceMappingURL=data:application/json')
    expect(nodeLoad).not.toHaveBeenCalled()
  })

  it('names the file when a source does not parse', async () => {
    await writeFile(join(root, 'lib', 'util.ts'), 'export const = ;\n')
    expect(() =>
      createPluginWorkerSourceHooks(root).load(fileUrl('lib/util.ts'), context, nodeLoad)
    ).toThrow(/cannot transpile lib\/util\.ts/)
  })

  it('leaves JavaScript and files outside the plugin to Node', () => {
    const hooks = createPluginWorkerSourceHooks(root)
    expect(hooks.load(fileUrl('lib/plain.js'), context, nodeLoad).source).toBe('node')
    const outside = pathToFileURL(join(tmpdir(), 'elsewhere.ts')).href
    expect(hooks.load(outside, context, nodeLoad).source).toBe('node')
    expect(hooks.load('node:fs', context, nodeLoad).source).toBe('node')
  })
})
