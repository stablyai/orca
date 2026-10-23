import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

export function createVitestZodBundle(root) {
  const temporary = join(root, '.tmp')
  mkdirSync(temporary, { recursive: true })
  const directory = mkdtempSync(join(temporary, 'vitest-zod-'))
  const path = join(directory, 'zod.mjs')
  const cleanup = () => rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  try {
    buildSync({
      absWorkingDir: root,
      entryPoints: [fileURLToPath(import.meta.resolve('zod'))],
      outfile: path,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      sourcemap: true
    })
    return { path, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
