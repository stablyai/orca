import fs, { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeTreeSync } from '../../../../src/shared/file-write/windows-transient-lock-removal'

// #46508: Bun on Windows deleted the cwd for a recursive rm('') (oven-sh/bun#47420).
it("treats a recursive rm('') like Node instead of deleting the cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-empty-path-rm-'))
  const sentinel = join(dir, 'sentinel.txt')
  writeFileSync(sentinel, 'keep')
  const previousCwd = process.cwd()
  process.chdir(dir)
  try {
    const cjsFs: typeof fs = createRequire(import.meta.url)('node:fs')
    const enoent = expect.objectContaining({ code: 'ENOENT' })

    expect(rmSync('', { recursive: true, force: true })).toBeUndefined()
    expect(cjsFs.rmSync('', { recursive: true, force: true })).toBeUndefined()
    expect(() => fs.rmSync('', { recursive: true })).toThrow(enoent)
    await expect(promisify(fs.rm)('', { recursive: true, force: true })).resolves.toBeUndefined()
    await expect(fsPromises.rm('', { recursive: true, force: true })).resolves.toBeUndefined()
    await expect(fs.promises.rm('', { recursive: true })).rejects.toEqual(enoent)

    expect(existsSync(sentinel)).toBe(true)
  } finally {
    process.chdir(previousCwd)
    removeTreeSync(dir)
  }
})
