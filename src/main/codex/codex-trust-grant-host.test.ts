import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  resolveCodexCommandMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: resolveCodexCommandMock
}))

import { resolveCodexTrustGrantHost } from './codex-trust-grant-host'

beforeEach(() => {
  execFileSyncMock.mockReset()
  // Stand in for the guest shell: rc banner first, then the payload inside the
  // command's own fence. The identity script execs, so no closing fence is written.
  execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
    const nonce = /__ORCA_WSL_CAPTURE_BEGIN_([^_]+)__/.exec(String(args.at(-1)))?.[1] ?? ''
    return (
      'To run a command as administrator (user "root"), use "sudo <command>".\n\n' +
      `__ORCA_WSL_CAPTURE_BEGIN_${nonce}__/home/alice/.local/bin/codex\ncodex-cli 1.2.3\n`
    )
  })
  resolveCodexCommandMock.mockReset()
  resolveCodexCommandMock.mockReturnValue(process.execPath)
})

describe('resolveCodexTrustGrantHost', () => {
  it('resolves the native command once for both the binary stamp and request', () => {
    const host = resolveCodexTrustGrantHost({ kind: 'native' })
    const input = {
      runtimeHomePath: '/tmp/codex-home',
      managedCommand: '/bin/sh codex-hook.sh',
      expectedTrustKeys: ['managed-key']
    }

    expect(host.binaryStamp).toMatchObject({ kind: 'native', path: process.execPath })
    expect(host.buildRequest(input).invocation.command).toBe(process.execPath)
    expect(host.buildRequest(input).invocation.command).toBe(process.execPath)
    // Why: PATH/version-manager scans are synchronous launch-path I/O. Reusing
    // the resolved command keeps one grant at one scan regardless of consumers.
    expect(resolveCodexCommandMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('builds WSL requests without scanning the native PATH', () => {
    const host = resolveCodexTrustGrantHost({
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
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu', '--exec', 'sh', '-c']),
      expect.objectContaining({ encoding: 'utf-8', timeout: 5_000, windowsHide: true })
    )
    expect(resolveCodexCommandMock).not.toHaveBeenCalled()
  })
})
