import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { binaryCapture, resolve, fallback } = vi.hoisted(() => ({
  binaryCapture: vi.fn(),
  resolve: vi.fn(),
  fallback: vi.fn()
}))
vi.mock('./exec-file-capture', () => ({
  execFileCaptureToTermination: binaryCapture
}))
vi.mock('./wsl-command-resolution', () => ({
  resolveCommand: resolve,
  resolveDefaultWslCli: fallback
}))
import { glabExecFileAsync } from './glab-exec-file'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x80])
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  resolve.mockImplementation((binary, args, cwd) => ({ binary, args, cwd, wsl: null }))
  fallback.mockReturnValue({
    binary: 'wsl.exe',
    args: ['--exec', 'glab', 'api', 'upload'],
    cwd: undefined,
    wsl: 'Ubuntu'
  })
  binaryCapture.mockResolvedValue({ stdout: bytes, stderr: Buffer.alloc(0) })
})
afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

describe('glab binary downloads', () => {
  it('preserves non-UTF-8 bytes through the termination barrier', async () => {
    const reply = await glabExecFileAsync(['api', 'upload'], { encoding: 'buffer' })
    expect(reply.stdout).toEqual(bytes)
    expect(binaryCapture).toHaveBeenCalledWith(
      'glab',
      ['api', 'upload'],
      expect.objectContaining({ encoding: 'buffer' }),
      undefined
    )
  })
  it('uses default WSL for cwd-less downloads when host glab is missing', async () => {
    binaryCapture.mockRejectedValueOnce(
      Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })
    )
    const signal = AbortSignal.timeout(15_000)
    expect(
      (await glabExecFileAsync(['api', 'upload'], { encoding: 'buffer', signal, timeout: 15_000 }))
        .stdout
    ).toEqual(bytes)
    expect(fallback).toHaveBeenCalledWith('glab', ['api', 'upload'])
    expect(binaryCapture).toHaveBeenLastCalledWith(
      'wsl.exe',
      expect.any(Array),
      expect.objectContaining({ signal, timeout: 15_000, encoding: 'buffer' }),
      undefined
    )
  })
  it('keeps a local repository failure local rather than changing execution host', async () => {
    binaryCapture.mockRejectedValueOnce(
      Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })
    )
    await expect(
      glabExecFileAsync(['api', 'upload'], { encoding: 'buffer', cwd: 'C:/repo' })
    ).rejects.toThrow('ENOENT')
    expect(fallback).not.toHaveBeenCalled()
  })
})
