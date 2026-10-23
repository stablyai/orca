import { afterEach, describe, expect, it, vi } from 'vitest'

const readFileSync = vi.fn()
vi.mock('node:fs', () => ({ readFileSync: (...args: unknown[]) => readFileSync(...args) }))

const { processStartIdentity } = await import('./desktop-app-process-identity')

describe('processStartIdentity', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    readFileSync.mockReset()
  })

  it('reads the Linux start time even when the command name has spaces and parentheses', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const tail = Array.from({ length: 20 }, (_, index) => String(index + 3))
    readFileSync.mockReturnValue(`900 (Web (Content) x) ${tail.join(' ')}`)
    expect(processStartIdentity(900)).toBe('22')
  })

  it('returns null when the process is gone or the platform has no cheap identity', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(processStartIdentity(900)).toBeNull()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(processStartIdentity(900)).toBeNull()
  })
})
