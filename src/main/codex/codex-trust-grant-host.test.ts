import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { resolveCodexTrustGrantHost } from './codex-trust-grant-host'

beforeEach(() => {
  runProcessMock.mockReset()
  // Stand in for the guest shell: rc banner first, then the payload inside the
  // command's own fence. The identity script execs, so no closing fence is written.
  runProcessMock.mockImplementation((spec: { args: string[] }) => {
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_ ([^_]+)__/.exec(String(spec.args.at(-1)))?.[1] ?? ''
    return Promise.resolve({
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
      stdout:
        'To run a command as administrator (user "root"), use "sudo <command>".\n\n' +
        `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__/home/alice/.local/bin/codex\ncodex-cli 1.2.3\n`
    })
  })
})

describe('resolveCodexTrustGrantHost', () => {
  it("builds WSL requests, stamped with the guest's codex path and version", async () => {
    const host = await resolveCodexTrustGrantHost({
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxRuntimeHome: '/home/alice/.codex-runtime'
    })
    const request = host.buildRequest({
      runtimeHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex-runtime',
      managedCommand: '/bin/sh codex-hook.sh',
      expectedTrustKeys: ['managed-key']
    })

    expect(host.binaryStamp).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu',
      path: '/home/alice/.local/bin/codex',
      version: 'codex-cli 1.2.3'
    })
    expect(request.invocation.command).toBe('wsl.exe')
    // Why (#16441): the identity probe runs through the shared async runner —
    // an execFileSync here froze the Electron main thread for its full timeout.
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        args: expect.arrayContaining(['-d', 'Ubuntu', '--exec', 'sh', '-c']),
        timeoutMs: 5_000
      })
    )
  })

  it('drops the stamp when the guest probe fails instead of trusting partial stdout', async () => {
    runProcessMock.mockResolvedValue({
      code: 127,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: 'codex not found'
    })

    const host = await resolveCodexTrustGrantHost({
      kind: 'wsl',
      distro: 'Ubuntu',
      linuxRuntimeHome: '/home/alice/.codex-runtime'
    })

    expect(host.binaryStamp).toBeNull()
  })
})
