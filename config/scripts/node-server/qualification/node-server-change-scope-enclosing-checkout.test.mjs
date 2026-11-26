import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../../../src/shared/file-write/windows-transient-lock-removal.ts'
import { collectNodeServerInputs } from './node-server-change-scope.mjs'

// Why temp-fixture IO stalls past the 30s global budget on a loaded gate host.
vi.setConfig({ testTimeout: 120_000 })

let outer
afterEach(() => removeTreeSync(outer))

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
