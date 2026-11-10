import { describe, expect, it, vi } from 'vitest'
import { resolveWslMappedDrivePath } from './wsl-mapped-drive-path'

describe('resolveWslMappedDrivePath', () => {
  it.each(['linux', 'darwin'] as const)('preserves drive-letter paths on %s', async (platform) => {
    await expect(resolveWslMappedDrivePath(String.raw`W:\home\dev\repo`, platform)).resolves.toBe(
      String.raw`W:\home\dev\repo`
    )
  })

  it('exposes a drive mapped to a WSL share as its UNC path', async () => {
    const realpath = vi.fn().mockResolvedValue(String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`)

    await expect(
      resolveWslMappedDrivePath(String.raw`W:\home\dev\repo`, 'win32', realpath)
    ).resolves.toBe(String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`)
  })

  it.each([
    ['a local drive', String.raw`C:\repo`, String.raw`C:\repo`],
    ['an SMB mapped drive', String.raw`Z:\repo`, String.raw`\\server\share\repo`]
  ])('preserves %s', async (_label, input, resolved) => {
    await expect(
      resolveWslMappedDrivePath(input, 'win32', vi.fn().mockResolvedValue(resolved))
    ).resolves.toBe(input)
  })

  it('preserves the input when the mapped drive is unavailable', async () => {
    await expect(
      resolveWslMappedDrivePath(
        String.raw`W:\home\dev\repo`,
        'win32',
        vi.fn().mockRejectedValue(new Error('unavailable'))
      )
    ).resolves.toBe(String.raw`W:\home\dev\repo`)
  })
})
