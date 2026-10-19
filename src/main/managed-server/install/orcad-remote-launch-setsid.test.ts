import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // Regression: `nohup … &` is killed when its `wsl.exe --exec` exits on a distro without systemd.
  it('never backgrounds under nohup, and starts the runtime in a session of its own', () => {
    const command = orcadLaunchCommand(
      host,
      spec('/home/u/.orca-remote/orcad-0.2.0+bb01'),
      'setsid'
    )
    expect(command).not.toContain('nohup')
    expect(command).toContain('setsid -f "$@"')
    // busybox has no `-f`; a background child of a non-interactive shell can still setsid.
    expect(command).toContain('else setsid "$@" & fi')
    expect(command).toContain(`${ORCAD_WSL_HOST_ENV}=1 sh -c`)
  })

  it('has the child record its own PID, since the setsid -f parent exits at once', () => {
    const command = orcadLaunchCommand(host, spec('/d/orcad-1'), 'setsid')
    const removeStale = command.indexOf(`rm -f '/d/orcad-1/${ORCAD_PID_FILENAME}'`)
    const recordOwn = command.indexOf(`echo $$ > "$1" && shift && exec "$@"`)
    expect(removeStale).toBeGreaterThan(-1)
    expect(recordOwn).toBeGreaterThan(removeStale)
    expect(command.trimEnd().endsWith(`cat '/d/orcad-1/${ORCAD_PID_FILENAME}'`)).toBe(true)
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
          // Already gone.
        }
      }
    }
  )
})
