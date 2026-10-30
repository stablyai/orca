import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCAD_PID_FILENAME, ORCAD_READINESS_FILENAME } from './orcad-remote-host-support'
import { orcadLaunchCommand, type OrcadLaunchSpec } from './orcad-remote-launch'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { ORCAD_WSL_HOST_ENV } from '../../ipc/wsl-guest-windows-drive-path'

const host = getRemoteHostPlatform('linux-x64')

function spec(remoteInstallDir: string, nodePath = '/usr/bin/node'): OrcadLaunchSpec {
  return {
    remoteInstallDir,
    nodePath,
    fullVersion: '0.2.0+bb01',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    activationRoot: '/home/u/.orca-remote/.orcad-activation-transaction'
  }
}

describe('the WSL launch (setsid)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // WSL without systemd can kill nohup children when wsl.exe exits; detach into a new session.
  it('never backgrounds under nohup, and starts the runtime in a session of its own', () => {
    const command = orcadLaunchCommand(
      host,
      spec('/home/u/.orca-remote/orcad-0.2.0+bb01'),
      'setsid'
    )
    expect(command).not.toContain('nohup')
    expect(command).toContain('setsid -f "$@"')
    // BusyBox lacks -f; background non-interactive children can still create their own session.
    expect(command).toContain('else setsid "$@" & fi')
    expect(command).toContain(`${ORCAD_WSL_HOST_ENV}=1 sh -c`)
  })

  it('has the child record its own PID, since the setsid -f parent exits at once', () => {
    const command = orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid')
    expect(command.startsWith(`orcad_pid='/d/orcad-1/${ORCAD_PID_FILENAME}';`)).toBe(true)
    const removeStale = command.indexOf('rm -f "$orcad_pid"')
    const recordOwn = command.indexOf(`echo $$ > "$1" && umask "$2" && shift 2 && exec "$@"`)
    expect(removeStale).toBeGreaterThan(-1)
    expect(recordOwn).toBeGreaterThan(removeStale)
    expect(command.trimEnd().endsWith('cat "$orcad_pid"')).toBe(true)
  })

  it('passes host facts the guest cannot read, quoted, and refuses a malformed name', () => {
    const command = orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid', [
      ['ORCA_WSL_DISTRO_GUID', "abc'd"]
    ])
    expect(command).toContain(`${ORCAD_WSL_HOST_ENV}=1 ORCA_WSL_DISTRO_GUID='abc'\\''d' sh -c`)
    expect(() =>
      orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid', [['BAD NAME', 'x']])
    ).toThrow('orcad_launch_env_name_invalid')
  })

  it('applies a keep-existing host fact only where the launching shell has none', () => {
    const command = orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid', [
      ['GLIBC_TUNABLES', 'glibc.malloc.mmap_threshold=16384', 'keep-existing']
    ])
    const assignment = 'GLIBC_TUNABLES="${GLIBC_TUNABLES:-glibc.malloc.mmap_threshold=16384}"'
    expect(command).toContain(`${assignment} sh -c`)
    const seen = (preset: string | undefined): string => {
      const { GLIBC_TUNABLES: _drop, ...env } = process.env
      return execFileSync('sh', ['-c', `${assignment} sh -c 'printf %s "$GLIBC_TUNABLES"'`], {
        env: preset === undefined ? env : { ...env, GLIBC_TUNABLES: preset }
      }).toString()
    }
    expect(seen(undefined)).toBe('glibc.malloc.mmap_threshold=16384')
    expect(seen('glibc.malloc.arena_max=2')).toBe('glibc.malloc.arena_max=2')
    // An empty value tunes nothing, so it counts as unset.
    expect(seen('')).toBe('glibc.malloc.mmap_threshold=16384')
    expect(() =>
      orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid', [['X', "a'b", 'keep-existing']])
    ).toThrow('orcad_launch_env_default_invalid')
    expect(() =>
      orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid', [['BAD NAME', 'x', 'keep-existing']])
    ).toThrow('orcad_launch_env_name_invalid')
  })

  it('keeps the SSH launch byte-for-byte when no detach is named', () => {
    const ssh = orcadLaunchCommand(host, spec('/d/orcad-1'))
    expect(ssh).toBe(orcadLaunchCommand(host, spec('/d/orcad-1'), 'nohup'))
    expect(ssh).toContain('exec nohup "$orcad_runtime"')
    expect(ssh).not.toContain('setsid')
    expect(ssh).not.toContain(ORCAD_WSL_HOST_ENV)
  })

  it.skipIf(process.platform !== 'linux')(
    'really detaches: the recorded PID is the runtime, in a new session, and writes readiness',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'orcad-setsid-'))
      dirs.push(dir)
      const runtime = join(dir, 'fake-node')
      writeFileSync(runtime, `#!/bin/sh\necho '{"type":"orca_server_ready"}'\nsleep 30\n`)
      chmodSync(runtime, 0o755)
      const out = execFileSync('sh', ['-c', orcadLaunchCommand(host, spec(dir, runtime), 'setsid')])
      const pid = Number(out.toString().trim())
      try {
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect(readFileSync(join(dir, ORCAD_PID_FILENAME), 'utf8').trim()).toBe(String(pid))
        const ps = (field: string, target: number): string =>
          execFileSync('ps', ['-o', `${field}=`, '-p', String(target)])
            .toString()
            .trim()
        expect(ps('args', pid)).toContain(join(dir, 'orcad.js'))
        expect(ps('sid', pid)).toBe(String(pid))
        expect(ps('sid', pid)).not.toBe(ps('sid', process.pid))
        for (let i = 0; i < 50 && !readFileSync(join(dir, ORCAD_READINESS_FILENAME), 'utf8'); i++) {
          execFileSync('sleep', ['0.05'])
        }
        expect(readFileSync(join(dir, ORCAD_READINESS_FILENAME), 'utf8')).toContain(
          'orca_server_ready'
        )
      } finally {
        try {
          process.kill(pid)
        } catch {
          // Cleanup tolerates children already reaped.
        }
      }
    }
  )

  // Daemon children create user files and must retain login umask (#31125).
  it.skipIf(process.platform !== 'linux')(
    'runs the daemon at the login umask while its PID and readiness files stay owner-only',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'orcad-setsid-umask-'))
      dirs.push(dir)
      const runtime = join(dir, 'fake-node')
      writeFileSync(runtime, `#!/bin/sh\n: > daemon-file\necho '{"type":"orca_server_ready"}'\n`)
      chmodSync(runtime, 0o755)
      const command = orcadLaunchCommand(host, spec(dir, runtime), 'setsid')
      execFileSync('sh', ['-c', `umask 022; ${command}`])
      for (let i = 0; i < 50 && !readFileSync(join(dir, ORCAD_READINESS_FILENAME), 'utf8'); i++) {
        execFileSync('sleep', ['0.05'])
      }
      const mode = (name: string): number => statSync(join(dir, name)).mode & 0o777
      expect(mode('daemon-file')).toBe(0o644)
      expect(mode(ORCAD_PID_FILENAME)).toBe(0o600)
      expect(mode(ORCAD_READINESS_FILENAME)).toBe(0o600)
    }
  )
})
