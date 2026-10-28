import { describe, expect, it } from 'vitest'
import {
  localSshdConfig,
  parseSshSidePathProbe,
  sshSidePathLeaks,
  sshSidePathProbeCommand
} from './ssh-hostile-host-local-sshd'

const input = {
  port: 42022,
  hostKey: '/tmp/orca-hh-a/host_key',
  pidFile: '/tmp/orca-hh-a/sshd.pid',
  authorizedKeys: '/tmp/orca-hh-a/authorized_keys',
  shimDir: '/tmp/orca-hh-a/bin',
  home: '/tmp/orca-hh-a/home'
}

describe('local sshd hostile host', () => {
  it('listens on loopback only and cuts PATH to the shims and the OS base', () => {
    const config = localSshdConfig(input).split('\n')
    expect(config).toContain('ListenAddress 127.0.0.1')
    expect(config).toContain('Port 42022')
    expect(config).toContain('PasswordAuthentication no')
    expect(config).toContain('Subsystem sftp internal-sftp')
    expect(config).toContain(
      'SetEnv PATH=/tmp/orca-hh-a/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME=/tmp/orca-hh-a/home'
    )
    expect(config.join('\n')).not.toMatch(/homebrew|\/usr\/local/)
  })

  it('refuses paths sshd_config would split', () => {
    expect(() => localSshdConfig({ ...input, home: '/tmp/with space/home' })).toThrow(
      'must not contain whitespace'
    )
  })

  it('reports every tool that escapes the shims, and any host Node', () => {
    const resolved = parseSshSidePathProbe(
      'npm=/tmp/orca-hh-a/bin/npm\ncc=/usr/bin/cc\nmake=\nnode=/opt/homebrew/bin/node\n'
    )
    expect(resolved).toEqual({
      npm: '/tmp/orca-hh-a/bin/npm',
      cc: '/usr/bin/cc',
      make: null,
      node: '/opt/homebrew/bin/node'
    })
    expect(sshSidePathLeaks(resolved, input.shimDir)).toEqual([
      'cc resolves to /usr/bin/cc',
      'make resolves to nothing',
      'node resolves to /opt/homebrew/bin/node'
    ])
    expect(sshSidePathLeaks({ npm: '/tmp/orca-hh-a/bin/npm', node: null }, input.shimDir)).toEqual(
      []
    )
  })

  it('probes each tool with command -v in one exec', () => {
    expect(sshSidePathProbeCommand(['npm', 'node'])).toBe(
      `printf '%s=%s\\n' npm "$(command -v npm)"; printf '%s=%s\\n' node "$(command -v node)"`
    )
  })
})
