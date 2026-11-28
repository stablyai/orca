import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { executeManifest } from './daemon-host-manifest'

const originalPlatform = process.platform
let root = ''

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'daemon-host-manifest-'))
  mkdirSync(path.join(root, 'src', 'keep', 'deep'), { recursive: true })
  mkdirSync(path.join(root, 'src', 'skip'))
  writeFileSync(path.join(root, 'src', 'keep', 'deep', 'a.node'), 'a')
  writeFileSync(path.join(root, 'src', 'skip', 'b.node'), 'b')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  rmSync(root, { recursive: true, force: true })
})

const filter = (sourcePath: string): boolean => !sourcePath.includes(`${path.sep}skip`)

it('copies a filtered folder on Windows without opendir and fails cleanly on a missing subfolder', async () => {
  const op = { sourcePath: path.join(root, 'src'), destRel: 'out', kind: 'dir' as const, filter }
  await executeManifest([op], root)
  expect(readdirSync(path.join(root, 'out'), { recursive: true }).sort()).toEqual(
    ['keep', path.join('keep', 'deep'), path.join('keep', 'deep', 'a.node')].sort()
  )

  symlinkSync(path.join(root, 'gone'), path.join(root, 'src', 'keep', 'missing'), 'junction')
  await expect(executeManifest([op], root)).rejects.toMatchObject({ code: 'ENOENT' })
})
