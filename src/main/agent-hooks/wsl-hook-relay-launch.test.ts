import { execFileSync } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  buildGuestInstallScript,
  buildGuestLaunchScript,
  spawnWslRelayProcess
} from './wsl-hook-relay-launch'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn((..._args: unknown[]) => ({ pid: 1 }))
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock
}))

describe('WSL hook relay guest launcher', () => {
  it('prefers a staged target-native Bun before probing Node', () => {
    const script = buildGuestLaunchScript('0.1.0+abc123')
    expect(script).toContain('bun-runtime-${orca_arch}-${orca_libc}')
    expect(script.indexOf('exec "$r"')).toBeLessThan(script.indexOf('command -v node'))
    expect(script).toContain('1.4.0')
    expect(script).toContain('exit 43')
  })

  it('streams optional Bun runtimes into the versioned guest install', () => {
    const script = buildGuestInstallScript(Buffer.from('relay'), '0.1.0+abc123', {
      'x64-glibc': Buffer.from('bun-binary')
    })
    expect(script).toContain('bun-runtime-x64-glibc')
    expect(script).toContain(Buffer.from('bun-binary').toString('base64'))
    expect(script).toContain('chmod 700 "$d/bun-runtime-x64-glibc"')
  })

  it('makes release launchers fail closed instead of probing distro Node', () => {
    const script = buildGuestLaunchScript('0.1.0+strict', { requiresBundledBun: true })
    execFileSync('sh', ['-n'], { input: script })
    expect(script).not.toContain('command -v node')
    expect(script).toContain('exit 43')
  })

  it('propagates the Bun-only policy into the installed launcher', () => {
    const script = buildGuestInstallScript(
      Buffer.from('relay'),
      '0.1.0+strict',
      { 'x64-glibc': Buffer.from('bun-binary') },
      { requiresBundledBun: true }
    )
    expect(script).not.toContain('command -v node')
    expect(script).toContain('exit 43')
  })
})

describe('spawnWslRelayProcess', () => {
  it('names an explicit Windows directory rather than inheriting one', () => {
    spawnWslRelayProcess('Ubuntu', {}, '1.2.3')

    // Why (#16463): the guest path is inside the `sh -c` command, so the Windows
    // cwd only decides whether CreateProcessW succeeds. Omitting it inherits
    // Orca's own — a `\\wsl.localhost` worktree the user can delete, after which
    // every relay launch fails `spawn wsl.exe ENOENT` for the rest of the session.
    expect(spawnMock).toHaveBeenCalledWith(
      'wsl.exe',
      expect.arrayContaining(['-d', 'Ubuntu', '--exec']),
      expect.objectContaining({ cwd: expect.any(String) })
    )
  })
})
