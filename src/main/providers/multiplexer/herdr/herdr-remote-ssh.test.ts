import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import { herdrRemoteDest, herdrRemoteSshArgs, writeHerdrRemoteSshLaunch } from './herdr-remote-ssh'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function target(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'box',
    label: 'box',
    host: 'box.example',
    port: 22,
    username: 'ada',
    ...overrides
  }
}

describe('herdr remote SSH dest', () => {
  it('uses the ssh-config host alias when the target came from ssh_config', () => {
    expect(herdrRemoteDest(target({ configHost: 'workbox', source: 'ssh-config' }))).toBe('workbox')
  })

  it('uses user@host for a manual target', () => {
    expect(herdrRemoteDest(target({ source: 'manual', port: 2222 }))).toBe('ada@box.example')
  })
})

describe('herdr remote SSH args', () => {
  it('joins an Orca ControlPath with ControlMaster=no', () => {
    if (process.platform === 'win32') {
      return
    }
    const { dest, joinControlPath, sshArgs } = herdrRemoteSshArgs(
      target({ configHost: 'workbox', source: 'ssh-config' }),
      { hostname: 'box.example', user: 'ada', port: 22 }
    )
    expect(dest).toBe('workbox')
    expect(joinControlPath).toBeTruthy()
    expect(sshArgs).toContain('ControlMaster=no')
    expect(sshArgs.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
    expect(sshArgs.some((arg) => arg.startsWith('ControlPersist='))).toBe(false)
  })

  it('keeps IdentityFile and -p for a manual host without a ControlPath', () => {
    const { dest, sshArgs } = herdrRemoteSshArgs(
      target({ source: 'manual', port: 2222, identityFile: '/keys/id_ed25519' })
    )
    expect(dest).toBe('ada@box.example')
    expect(sshArgs).toContain('-p')
    expect(sshArgs).toContain('2222')
    expect(sshArgs).toContain('-i')
    expect(sshArgs).toContain('/keys/id_ed25519')
  })
})

describe('writeHerdrRemoteSshLaunch', () => {
  it('writes a herdr config that stops Herdr managing ssh and a PATH ssh shim', () => {
    const bin = mkdtempSync(join(tmpdir(), 'orca-fake-ssh-'))
    dirs.push(bin)
    const sshBinary = join(bin, process.platform === 'win32' ? 'ssh.exe' : 'ssh')
    writeFileSync(sshBinary, 'echo')
    const launch = writeHerdrRemoteSshLaunch({
      target: target({ source: 'manual', identityFile: '/keys/id_ed25519' }),
      sshBinary
    })
    const pathValue = launch.env.PATH ?? ''
    dirs.push(pathValue.split(process.platform === 'win32' ? ';' : ':')[0] ?? '')
    expect(readFileSync(launch.env.HERDR_CONFIG_PATH ?? '', 'utf8')).toContain(
      'manage_ssh_config = false'
    )
    const shimName = process.platform === 'win32' ? 'ssh.cmd' : 'ssh'
    const shimDir = pathValue.split(process.platform === 'win32' ? ';' : ':')[0]
    const shim = readFileSync(join(shimDir ?? '', shimName), 'utf8')
    expect(shim).toContain('/keys/id_ed25519')
    expect(launch.dest).toBe('ada@box.example')
  })
})
