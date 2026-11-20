import { afterEach, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { resolveCodexTrustGrantHost } from './codex-trust-grant-host'

afterEach(() => {
  vi.unstubAllEnvs()
  runProcessMock.mockReset()
})

it('uses System32 wsl.exe for both binary probe and trust grant invocation', async () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  runProcessMock.mockResolvedValueOnce({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })

  const resolved = await resolveCodexTrustGrantHost({
    kind: 'wsl',
    distro: 'Ubuntu',
    linuxRuntimeHome: '/home/dev/.codex'
  })

  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({
      program: 'D:\\Windows\\System32\\wsl.exe'
    })
  )
  const request = resolved.buildRequest({
    runtimeHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex',
    managedCommand: 'node hook.js',
    expectedTrustKeys: ['key-1']
  })
  expect(request.invocation.command).toBe('D:\\Windows\\System32\\wsl.exe')
})
