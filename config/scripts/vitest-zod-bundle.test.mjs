import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('reuses bundles, invalidates imported sources and repairs corrupt output without removing active bundles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-vitest-zod-'))
  try {
    mkdirSync(join(root, 'node_modules', 'zod'), { recursive: true })
    const require = createRequire(import.meta.url)
    symlinkSync(
      dirname(require.resolve('esbuild/package.json')),
      join(root, 'node_modules', 'esbuild'),
      'junction'
    )
    writeFileSync(
      join(root, 'node_modules', 'zod', 'package.json'),
      JSON.stringify({ type: 'module', exports: './index.js' })
    )
    writeFileSync(join(root, 'node_modules', 'zod', 'index.js'), "export { z } from './value.js'")
    const source = join(root, 'node_modules', 'zod', 'value.js')
    writeFileSync(source, 'export const z = 1')
    const script = join(root, 'vitest-zod-bundle.mjs')
    copyFileSync(resolve('config/scripts/vitest-zod-bundle.mjs'), script)
    const { createVitestZodBundle } = await import(pathToFileURL(script).href)
    const first = createVitestZodBundle(root)
    first.cleanup()
    expect(existsSync(first.path)).toBe(true)
    expect((await import(pathToFileURL(first.path).href)).z).toBe(1)
    expect(createVitestZodBundle(root).path).toBe(first.path)
    writeFileSync(source, 'export const z = 2')
    const updated = createVitestZodBundle(root)
    expect(updated.path).not.toBe(first.path)
    expect((await import(pathToFileURL(updated.path).href)).z).toBe(2)
    expect(readFileSync(first.path, 'utf8')).toContain('= 1')
    writeFileSync(updated.path, 'corrupted bundle')
    const repaired = createVitestZodBundle(root)
    expect((await import(pathToFileURL(repaired.path).href)).z).toBe(2)
    rmSync(`${repaired.path}.map`)
    const complete = createVitestZodBundle(root)
    expect(existsSync(`${complete.path}.map`)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
