import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import type { SystemSshResolvedConfig } from './ssh-control-socket'
import { buildTeleportSshCommand, buildTeleportSshPortForwardCommand } from './teleport-ssh-command'

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'teleport-target',
    label: 'Teleport node',
    host: 'node.internal',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createResolvedConfig(
  overrides?: Partial<SystemSshResolvedConfig>
): SystemSshResolvedConfig {
  return {
    hostname: 'resolved.internal',
    port: 22,
    user: 'resolved-user',
    identityFile: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

describe('buildTeleportSshCommand', () => {
  it('turns the reported tsh ssh ProxyCommand into a direct Teleport command', () => {
    const command = buildTeleportSshCommand(createTarget({ proxyCommand: 'tsh ssh root@%h' }))

    expect(command).toEqual({
      executable: 'tsh',
      args: ['ssh', 'root@node.internal'],
      targetIndex: 1
    })
  })

  it('expands OpenSSH host, port, user, and literal-percent tokens', () => {
    const command = buildTeleportSshCommand(
      createTarget({
        port: 3022,
        proxyCommand: 'tsh ssh --reason=%%-%h-%p-%r --port=%p %r@%h'
      })
    )

    expect(command?.args).toEqual([
      'ssh',
      '--reason=%-node.internal-3022-deploy',
      '--port=3022',
      'deploy@node.internal'
    ])
  })

  it('adds a non-default target port before the Teleport host', () => {
    const command = buildTeleportSshCommand(
      createTarget({
        port: 3022,
        proxyCommand: 'tsh --proxy=teleport.example.com ssh --cluster=leaf %r@%h'
      })
    )

    expect(command?.args).toEqual([
      '--proxy=teleport.example.com',
      'ssh',
      '--cluster=leaf',
      '-p',
      '3022',
      'deploy@node.internal'
    ])
    expect(command?.targetIndex).toBe(5)
  })

  it('keeps an explicit Teleport port instead of adding another', () => {
    const command = buildTeleportSshCommand(
      createTarget({ port: 3022, proxyCommand: 'tsh ssh --port=2022 %r@%h' })
    )

    expect(command?.args).toEqual(['ssh', '--port=2022', 'deploy@node.internal'])
  })

  it('uses a quoted tsh executable path and appends the remote command', () => {
    const command = buildTeleportSshCommand(
      createTarget({
        proxyCommand: '"/Applications/Teleport Connect.app/Contents/MacOS/tsh" ssh root@%h'
      }),
      undefined,
      "exec /bin/sh -c 'echo ready'"
    )

    expect(command).toEqual({
      executable: '/Applications/Teleport Connect.app/Contents/MacOS/tsh',
      args: ['ssh', 'root@node.internal', "exec /bin/sh -c 'echo ready'"],
      targetIndex: 1
    })
  })

  it('recognizes a quoted Windows tsh executable path', () => {
    const command = buildTeleportSshCommand(
      createTarget({
        proxyCommand: '"C:\\Program Files\\Teleport\\tsh.exe" ssh root@%h'
      })
    )

    expect(command?.executable).toBe('C:\\Program Files\\Teleport\\tsh.exe')
    expect(command?.args).toEqual(['ssh', 'root@node.internal'])
  })

  it('uses fresh resolved config for an imported SSH alias', () => {
    const command = buildTeleportSshCommand(
      createTarget({
        source: 'ssh-config',
        configHost: 'teleport-node',
        host: 'stale.internal',
        username: '',
        proxyCommand: 'tsh ssh stale@%h'
      }),
      createResolvedConfig({ proxyCommand: 'tsh ssh %r@%h', port: 3022 })
    )

    expect(command?.args).toEqual(['ssh', '-p', '3022', 'resolved-user@resolved.internal'])
  })

  it('leaves raw tsh proxy ssh commands on the OpenSSH transport', () => {
    expect(
      buildTeleportSshCommand(
        createTarget({ proxyCommand: 'tsh proxy ssh --cluster=leaf %r@%h:%p' })
      )
    ).toBeNull()
  })

  it.each([
    'cloudflared access ssh --hostname %h',
    'tsh ssh root@%h 2>/dev/null',
    'tsh ssh root@%h uptime',
    'tsh ssh "root@%h',
    'env TELEPORT_HOME=/tmp/tsh tsh ssh root@%h',
    '~/bin/tsh ssh root@%h',
    '%LOCALAPPDATA%\\Teleport\\tsh.exe ssh root@%h',
    '"$HOME/bin/tsh" ssh root@%h',
    'tsh ssh --reason="$REASON" root@%h',
    'tsh ssh --cluster=leaf* root@%h'
  ])('leaves unsupported proxy syntax unchanged: %s', (proxyCommand) => {
    expect(buildTeleportSshCommand(createTarget({ proxyCommand }))).toBeNull()
  })
})

describe('buildTeleportSshPortForwardCommand', () => {
  it('places tsh local forwarding flags before the host argument', () => {
    const command = buildTeleportSshPortForwardCommand(
      createTarget({ proxyCommand: 'tsh ssh root@%h' }),
      5173,
      '127.0.0.1',
      3000
    )

    expect(command).toEqual({
      executable: 'tsh',
      args: ['ssh', '-L', '127.0.0.1:5173:127.0.0.1:3000', 'root@node.internal'],
      targetIndex: 3
    })
  })
})
