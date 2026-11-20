import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { collectNodeServerInputs } from './node-server-change-scope.mjs'

let outer
afterEach(() => rmSync(outer, { recursive: true, force: true }))

it('ignores warnings from an enclosing checkout but not from the repo', async () => {
  const duplicateKey = '{ "name": "x", "name": "y" }'
  outer = mkdtempSync(join(tmpdir(), 'node-server-scope-outer-'))
  const root = join(outer, 'repo')
  mkdirSync(root)
  writeFileSync(join(outer, 'package.json'), duplicateKey)
  writeFileSync(join(root, 'entry.ts'), 'export {}')
  const collect = () => collectNodeServerInputs({ root, entryPoints: ['entry.ts'] })
  expect([...(await collect())]).toEqual(['entry.ts'])
  writeFileSync(join(root, 'package.json'), duplicateKey)
  await expect(collect()).rejects.toThrow('Duplicate key')
})
