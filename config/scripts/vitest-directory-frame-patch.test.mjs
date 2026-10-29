import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

// Bun names builtins `native:L:C`; Vitest resolved that against the repo root, read the `native/`
// directory as a source map and crashed the run (EISDIR), hiding the real failure. The patch
// reads source maps only from files; an upgrade that drops it fails here.
it('reads stack-frame source maps only from files', () => {
  const vitestRoot = dirname(createRequire(import.meta.url).resolve('vitest/package.json'))
  const chunks = join(vitestRoot, 'dist', 'chunks')
  const cliApi = readdirSync(chunks).find((name) => /^cli-api\..+\.js$/.test(name))
  expect(cliApi).toBeDefined()
  expect(readFileSync(join(chunks, String(cliApi)), 'utf8')).toContain(
    'existsSync(file) && statSync(file).isFile()'
  )
})
