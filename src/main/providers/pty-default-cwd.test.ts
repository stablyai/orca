import { beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn()
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

import {
  assertSafeAgentStartupCwd,
  isSafeImplicitPtyCwd,
  resolveSafePtyDefaultCwd
} from './pty-default-cwd'

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

describe('pty default cwd safety', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    setPlatform(originalPlatform)
    homedirMock.mockReset()
    homedirMock.mockReturnValue('/home/orca')
  })

  it('rejects root-like implicit cwd values', () => {
    expect(isSafeImplicitPtyCwd(undefined)).toBe(false)
    expect(isSafeImplicitPtyCwd('')).toBe(false)
    expect(isSafeImplicitPtyCwd('/')).toBe(false)
    expect(isSafeImplicitPtyCwd('C:\\')).toBe(false)
    expect(isSafeImplicitPtyCwd('\\\\server\\share')).toBe(false)
  })

  it('uses a non-root POSIX home and skips root env values', () => {
    setPlatform('linux')

    expect(resolveSafePtyDefaultCwd({ HOME: '/home/alice' })).toBe('/home/alice')
    expect(resolveSafePtyDefaultCwd({ HOME: '/' })).toBe('/home/orca')
  })

  it('throws instead of falling back to POSIX root', () => {
    setPlatform('darwin')
    homedirMock.mockReturnValue('/')

    expect(() => resolveSafePtyDefaultCwd({ HOME: '/' })).toThrow(
      /No safe default working directory/
    )
  })

  it('uses Windows home candidates without accepting drive roots', () => {
    setPlatform('win32')
    homedirMock.mockReturnValue('C:\\Users\\os-home')

    expect(
      resolveSafePtyDefaultCwd({
        USERPROFILE: 'C:\\',
        HOMEDRIVE: 'D:',
        HOMEPATH: '\\Users\\alice'
      })
    ).toBe('D:\\Users\\alice')
  })

  it('requires automatic agent startup commands to provide a non-root cwd', () => {
    expect(() => assertSafeAgentStartupCwd(undefined, 'codex')).toThrow(
      /requires a non-root workspace/
    )
    expect(() => assertSafeAgentStartupCwd('/', 'claude')).toThrow(/requires a non-root workspace/)
    expect(() => assertSafeAgentStartupCwd('/repo', 'codex')).not.toThrow()
  })
})
