import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createVitestZodBundle } from './vitest-zod-bundle.mjs'

let root
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('reuses one bundle across runs and removes directories leaked by killed runs', () => {
  root = mkdtempSync(join(tmpdir(), 'orca-zod-bundle-'))
  const leaked = join(root, '.tmp', 'vitest-zod-leaked')
  const active = join(root, '.tmp', 'vitest-zod-active')
  mkdirSync(leaked, { recursive: true })
  mkdirSync(active)
  const hoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(leaked, hoursAgo, hoursAgo)

  const first = createVitestZodBundle(root)
  const second = createVitestZodBundle(root)

  expect(second.path).toBe(first.path)
  expect(existsSync(first.path)).toBe(true)
  expect(existsSync(leaked)).toBe(false)
  expect(existsSync(active)).toBe(true)
})
