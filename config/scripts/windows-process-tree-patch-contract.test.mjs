import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')

describe('Windows process-tree patch contract', () => {
  it('keeps the patch LF-only and hash-synced with the lockfile', () => {
    const patchBytes = readFileSync(
      join(projectDir, 'config/patches/@vscode__windows-process-tree@0.8.0.patch')
    )
    // pnpm hashes patches CRLF-normalized, so CR bytes cannot affect install
    // behavior; keep the file LF-only so the bytes match main and diff clean.
    expect(patchBytes.includes(0x0d)).toBe(false)
    const patchHash = createHash('sha256')
      .update(patchBytes.toString('utf8').replaceAll('\r\n', '\n'))
      .digest('hex')
    const lockfile = readFileSync(join(projectDir, 'pnpm-lock.yaml'), 'utf8')
    expect(lockfile).toContain(`hash: ${patchHash}`)
  })
})
