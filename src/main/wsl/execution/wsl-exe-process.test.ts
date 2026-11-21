import { afterEach, expect, it, vi } from 'vitest'
import { wslExeProcessSpec } from './wsl-exe-process'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('builds wsl.exe specs with the absolute System32 binary path', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows')

  expect(wslExeProcessSpec(['--list', '--quiet'], 5_000)).toEqual(
    expect.objectContaining({
      program: 'D:\\Windows\\System32\\wsl.exe',
      args: ['--list', '--quiet'],
      timeoutMs: 5_000
    })
  )
})
