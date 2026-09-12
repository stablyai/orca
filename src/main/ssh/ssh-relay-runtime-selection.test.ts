import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  posixRelayRuntimeExpression,
  relayBundledBunPath,
  windowsRelayRuntimeSelection
} from './ssh-relay-runtime-selection'

describe('relay runtime selection', () => {
  it('prefers an executable bundled Bun and falls back to host Node on POSIX', () => {
    const host = getRemoteHostPlatform('linux-x64')
    const expression = posixRelayRuntimeExpression(
      host,
      '/home/me user/.orca-remote/relay-v1',
      '/opt/Node JS/bin/node',
      'glibc'
    )

    expect(expression).toContain("[ -x '/home/me user/.orca-remote/relay-v1/bun-runtime-glibc' ]")
    expect(expression).toContain(
      "'/home/me user/.orca-remote/relay-v1/bun-runtime-glibc' --version"
    )
    expect(expression).toContain("'/home/me user/.orca-remote/relay-v1/bun-runtime' --version")
    expect(expression).toContain("= '1.4.0'")
    expect(expression).toContain("printf '%s' '/opt/Node JS/bin/node'")
    expect(expression.startsWith('$(')).toBe(true)
    // The production host is POSIX here; Windows CI has no bash executable.
    if (process.platform !== 'win32') {
      expect(() =>
        execFileSync('bash', ['-n'], {
          input: `"${expression}" relay.js --connect`,
          stdio: ['pipe', 'ignore', 'pipe']
        })
      ).not.toThrow()
    }
    expect(expression).not.toContain('latest')
  })

  it('maps musl Linux hosts to the musl runtime before trying the legacy name', () => {
    const expression = posixRelayRuntimeExpression(
      getRemoteHostPlatform('linux-arm64'),
      '/relay',
      '/usr/bin/node',
      'musl'
    )
    expect(expression).toContain("'/relay/bun-runtime-musl' --version")
    expect(expression.indexOf('bun-runtime-musl')).toBeLessThan(
      expression.indexOf("bun-runtime' --version")
    )
  })

  it('keeps an exact strict Bun path executable when callers quote the expression', () => {
    const expression = posixRelayRuntimeExpression(
      getRemoteHostPlatform('linux-x64'),
      '/relay',
      '/relay/bun-runtime-glibc'
    )
    expect(expression).toBe("$(printf '%s' '/relay/bun-runtime-glibc')")
    expect(expression).not.toContain("'/usr/bin/node'")
  })

  it('uses Windows literal paths and leaves Node as the safe default', () => {
    const host = getRemoteHostPlatform('win32-x64')
    const path = relayBundledBunPath(host, 'C:/Users/me/.orca-remote/relay-v1')
    const selection = windowsRelayRuntimeSelection(
      host,
      'C:/Users/me/.orca-remote/relay-v1',
      'C:/Program Files/nodejs/node.exe'
    )

    expect(path).toBe('C:/Users/me/.orca-remote/relay-v1/bun-runtime.exe')
    expect(selection).toContain("$runtime = 'C:/Program Files/nodejs/node.exe'")
    expect(selection).toContain("$bundledBun = 'C:/Users/me/.orca-remote/relay-v1/bun-runtime.exe'")
    expect(selection).toContain('Test-Path -LiteralPath $bundledBun -PathType Leaf')
    expect(selection).toContain("$bunVersion -eq '1.4.0'")
    expect(selection).toContain('$runtime = $bundledBun')
  })

  it('rejects mixing host dialects', () => {
    expect(() =>
      posixRelayRuntimeExpression(getRemoteHostPlatform('win32-x64'), 'C:/relay', 'node')
    ).toThrow('POSIX relay runtime expression requires a POSIX host')
    expect(() =>
      windowsRelayRuntimeSelection(getRemoteHostPlatform('linux-x64'), '/relay', 'node')
    ).toThrow('Windows relay runtime selection requires a Windows host')
  })
})
