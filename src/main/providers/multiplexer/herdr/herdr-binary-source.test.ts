import { describe, expect, it } from 'vitest'
import { normalizeHerdrBinarySource } from '../../../../shared/terminal-backend'
import { resolveHerdrExecutable } from './herdr-provider-factory'

describe('stock Herdr binary source', () => {
  it('migrates missing and experimental managed settings to PATH', () => {
    expect(normalizeHerdrBinarySource(undefined)).toEqual({ kind: 'system' })
    expect(normalizeHerdrBinarySource({ kind: 'managed' })).toEqual({ kind: 'system' })
  })

  it('uses the target platform executable for PATH installs', () => {
    expect(resolveHerdrExecutable({ kind: 'system' }, 'darwin')).toBe('herdr')
    expect(resolveHerdrExecutable({ kind: 'system' }, 'win32')).toBe('herdr.exe')
  })

  it('preserves a configured executable path', () => {
    expect(resolveHerdrExecutable({ kind: 'custom', path: ' /opt/herdr ' }, 'linux')).toBe(
      '/opt/herdr'
    )
  })
})
