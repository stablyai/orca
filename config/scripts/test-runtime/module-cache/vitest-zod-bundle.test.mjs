import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createVitestZodBundle } from './vitest-zod-bundle.mjs'

let root
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('removes stale directories leaked by killed runs and preserves recent ones', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-zod-bundle-'))
  const leaked = join(root, '.tmp', 'vitest-zod-leaked')
  const active = join(root, '.tmp', 'vitest-zod-active')
  mkdirSync(leaked, { recursive: true })
  mkdirSync(active)
  const hoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(leaked, hoursAgo, hoursAgo)

  const bundle = createVitestZodBundle(root)

  expect(existsSync(bundle.path)).toBe(true)
  expect(existsSync(leaked)).toBe(false)
  expect(existsSync(active)).toBe(true)
})
