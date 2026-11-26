import { spawn as spawnChild } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import { pinWslHostLinuxUsers } from './wsl-orcad-host-user'

// #49180: a pinned host's every wsl.exe call names its account, whatever the distro's default is.
function argsOfOneExec(distro: string): Promise<readonly string[]> {
  let seen: readonly string[] = []
  const spawn: PipedProcessSpawner = (spec) => {
    seen = spec.args ?? []
    return spawnChild(process.execPath, ['-e', ''], { stdio: 'pipe' })
  }
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: `wsl:${distro}`, distro, label: distro },
    spawn,
    commandLoops: false
  })
  return transport.exec('true').then((channel) => {
    channel.destroy()
    return seen
  })
}

describe('WSL host Linux user pin', () => {
  afterEach(() => pinWslHostLinuxUsers([]))

  it('runs a pinned host as its account and an unpinned one as the default user', async () => {
    pinWslHostLinuxUsers([{ distro: 'Ubuntu-24.04', linuxUser: 'root' }, { distro: 'Debian' }])
    expect(await argsOfOneExec('ubuntu-24.04')).toEqual([
      '-d',
      'ubuntu-24.04',
      '-u',
      'root',
      '--exec',
      'sh',
      '-c',
      'true'
    ])
    expect(await argsOfOneExec('Debian')).toEqual(['-d', 'Debian', '--exec', 'sh', '-c', 'true'])
  })

  it('drops a pin once its record is gone', async () => {
    pinWslHostLinuxUsers([{ distro: 'Ubuntu', linuxUser: 'alice' }])
    pinWslHostLinuxUsers([])
    expect(await argsOfOneExec('Ubuntu')).not.toContain('-u')
  })
})
