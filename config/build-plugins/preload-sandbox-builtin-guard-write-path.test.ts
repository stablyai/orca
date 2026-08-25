// Why: direct-hook unit calls cannot show ordering. These drive a real Vite write path to prove
// a rejected preload leaves nothing on disk while a clean one still emits.
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { createPreloadSandboxBuiltinGuardPlugin } from './preload-sandbox-builtin-guard'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

async function buildPreload(source: string): Promise<{ outDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-preload-guard-'))
  roots.push(root)
  const outDir = join(root, 'out')
  await writeFile(join(root, 'preload.ts'), source, 'utf8')
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir,
      // Matches the preload target: builtins stay external instead of being browser-polyfilled.
      ssr: true,
      write: true,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: { preload: join(root, 'preload.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' },
        plugins: [createPreloadSandboxBuiltinGuardPlugin()]
      }
    }
  })
  return { outDir }
}

describe('preload sandbox guard on a real build write path', () => {
  it('leaves no output on disk when the preload imports a Node builtin', async () => {
    const attempt = buildPreload(
      "import { join } from 'node:path'\nimport { contextBridge } from 'electron'\n" +
        "contextBridge.exposeInMainWorld('api', { join })\n"
    )
    await expect(attempt).rejects.toThrow('node:path')
    await expect(readdir(join(roots.at(-1)!, 'out'))).rejects.toThrow(/ENOENT/)
  }, 60_000)

  it('writes a preload whose only external is electron', async () => {
    const { outDir } = await buildPreload(
      "import { contextBridge } from 'electron'\n" +
        "contextBridge.exposeInMainWorld('api', { encode: (v: string) => new TextEncoder().encode(v) })\n"
    )
    await expect(readdir(outDir)).resolves.toContain('preload.js')
  }, 60_000)
})
