import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, homedirMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  homedirMock: vi.fn()
}))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

import { codexAuthExists } from './codex-auth-presence'

describe('codexAuthExists', () => {
  const originalCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    vi.clearAllMocks()
    homedirMock.mockReturnValue('/home/alice')
    delete process.env.CODEX_HOME
  })

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = originalCodexHome
    }
  })

  it('checks an explicit managed-account home first', () => {
    existsSyncMock.mockReturnValue(true)

    expect(codexAuthExists('/managed/home')).toBe(true)
    expect(existsSyncMock).toHaveBeenCalledWith(join('/managed/home', 'auth.json'))
  })

  it('falls back to CODEX_HOME when no home is provided', () => {
    process.env.CODEX_HOME = '/custom/codex'
    existsSyncMock.mockReturnValue(true)

    expect(codexAuthExists()).toBe(true)
    expect(existsSyncMock).toHaveBeenCalledWith(join('/custom/codex', 'auth.json'))
  })

  it('falls back to ~/.codex when neither home nor CODEX_HOME is set', () => {
    existsSyncMock.mockReturnValue(false)

    expect(codexAuthExists()).toBe(false)
    expect(existsSyncMock).toHaveBeenCalledWith(join('/home/alice', '.codex', 'auth.json'))
  })

  it('returns false instead of throwing when the fs check fails', () => {
    existsSyncMock.mockImplementation(() => {
      throw new Error('EACCES')
    })

    expect(codexAuthExists('/managed/home')).toBe(false)
  })
})
