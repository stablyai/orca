import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type * as Fs from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// A filtered cpSync walks folders with opendirSync, which can crash on Windows.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    cpSync: (...args: Parameters<typeof fs.cpSync>) => {
      if (process.platform === 'win32' && args[2]?.filter) {
        throw new Error('filtered cpSync on Windows')
      }
      return fs.cpSync(...args)
    }
  }
})

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

it('copies a filtered folder on Windows without opendir and fails cleanly on a missing subfolder', () => {
  const op = { sourcePath: path.join(root, 'src'), destRel: 'out', kind: 'dir' as const, filter }
  executeManifest([op], root)
  expect(readdirSync(path.join(root, 'out'), { recursive: true }).sort()).toEqual(
    ['keep', path.join('keep', 'deep'), path.join('keep', 'deep', 'a.node')].sort()
  )

  symlinkSync(path.join(root, 'gone'), path.join(root, 'src', 'keep', 'missing'), 'junction')
  expect(() => executeManifest([op], root)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
})
