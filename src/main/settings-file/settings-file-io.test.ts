import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTransientWriteFailure, writeSettingsFile } from './settings-file-io'

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('settings file write failure classification', () => {
  it('treats EPERM and EBUSY as transient only on Windows', () => {
    expect(isTransientWriteFailure(errnoError('EPERM'), 'win32')).toBe(true)
    expect(isTransientWriteFailure(errnoError('EBUSY'), 'win32')).toBe(true)
    expect(isTransientWriteFailure(errnoError('EPERM'), 'darwin')).toBe(false)
    expect(isTransientWriteFailure(errnoError('EBUSY'), 'linux')).toBe(false)
  })

  it('does not treat permission failures as transient on Windows', () => {
    expect(isTransientWriteFailure(errnoError('EACCES'), 'win32')).toBe(false)
    expect(isTransientWriteFailure(new Error('boom'), 'win32')).toBe(false)
  })
})

describe('settings file write', () => {
  it('does not replace a file edited after it was read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-settings-file-io-'))
    try {
      const path = join(dir, 'settings.json')
      writeFileSync(path, '{ "theme": "light" }\n')

      const result = await writeSettingsFile(path, '{ "theme": "dark" }\n', '{}\n')

      expect(result).toEqual({ kind: 'changed' })
      expect(readFileSync(path, 'utf-8')).toBe('{ "theme": "light" }\n')
      expect(readdirSync(dir)).toEqual(['settings.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
