import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomically } from './fs-utils'

describe('writeFileAtomically', () => {
  let dir: string

  function setup(): string {
    dir = mkdtempSync(join(tmpdir(), 'orca-fs-utils-'))
    return dir
  }

  function cleanup(): void {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('writes a file atomically', () => {
    setup()
    try {
      const target = join(dir, 'test.json')
      writeFileAtomically(target, '{"key":"value"}\n')

      expect(readFileSync(target, 'utf-8')).toBe('{"key":"value"}\n')
    } finally {
      cleanup()
    }
  })

  it('overwrites an existing file', () => {
    setup()
    try {
      const target = join(dir, 'test.json')
      writeFileAtomically(target, 'old')
      writeFileAtomically(target, 'new')

      expect(readFileSync(target, 'utf-8')).toBe('new')
    } finally {
      cleanup()
    }
  })

  it('applies the mode option to the written file', () => {
    if (process.platform === 'win32') {
      return
    }

    setup()
    try {
      const target = join(dir, 'secret.json')
      writeFileAtomically(target, '{"token":"abc"}\n', { mode: 0o600 })

      const mode = statSync(target).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      cleanup()
    }
  })

  it('cleans up temp file on write failure', () => {
    setup()
    try {
      const target = join(dir, 'nonexistent-dir', 'nested', 'test.json')

      expect(() => writeFileAtomically(target, 'data')).toThrow()

      const tmpFiles = existsSync(dir)
        ? require('node:fs')
            .readdirSync(dir)
            .filter((f: string) => f.endsWith('.tmp'))
        : []
      expect(tmpFiles).toHaveLength(0)
    } finally {
      cleanup()
    }
  })
})
