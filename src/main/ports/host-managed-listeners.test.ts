import { describe, expect, it } from 'vitest'
import { hostManagedListenerConfig, isHostManagedListener } from './host-managed-listeners'

const config = (roots: string[] = ['/opt/orca'], unownedPorts: number[] = [23456]) => ({
  roots,
  unownedPorts: new Set(unownedPorts)
})

describe('host-managed listeners', () => {
  it('reads absolute roots and platform ports from the environment', () => {
    const parsed = hostManagedListenerConfig({
      ORCA_HOST_MANAGED_LISTENER_PATHS: '/opt/orca/:relative:/srv/tools',
      ORCA_HOST_MANAGED_UNOWNED_PORTS: '23456, x,70000'
    })
    expect(parsed.roots).toEqual(['/opt/orca', '/srv/tools'])
    expect([...parsed.unownedPorts]).toEqual([23456])
    expect(hostManagedListenerConfig({})).toEqual({ roots: [], unownedPorts: new Set() })
  })

  it('marks the server itself and programs started from a managed root', () => {
    expect(isHostManagedListener({ pid: 27, port: 6768 }, config(), 27)).toBe(true)
    expect(
      isHostManagedListener(
        { pid: 90, port: 2222, commandLine: '/opt/orca/openssh/sbin/sshd -D -f x' },
        config(),
        27
      )
    ).toBe(true)
    expect(
      isHostManagedListener(
        {
          pid: 91,
          port: 6080,
          commandLine: 'python3 /opt/orca/bin/orca-desktop-proxy --port 6080'
        },
        config(),
        27
      )
    ).toBe(true)
  })

  it('marks a pid-less listener only on a declared platform port', () => {
    expect(isHostManagedListener({ port: 23456 }, config(), 27)).toBe(true)
    // A root-run postgres or Docker-published port has no visible pid but is the user's.
    expect(isHostManagedListener({ port: 5432 }, config(), 27)).toBe(false)
    expect(isHostManagedListener({ port: 23456 }, config(['/opt/orca'], []), 27)).toBe(false)
  })

  it('leaves user servers alone, matching by program path rather than port', () => {
    expect(
      isHostManagedListener(
        { pid: 92, port: 6768, commandLine: 'python3 -m http.server 6768' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      isHostManagedListener(
        { pid: 92, port: 23456, commandLine: 'python3 -m http.server 23456' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      isHostManagedListener(
        { pid: 93, port: 5173, commandLine: 'node vite --config /opt/orca/x.js' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      isHostManagedListener({ pid: 94, port: 1, commandLine: '/opt/orcaother/bin/x' }, config(), 27)
    ).toBe(false)
    expect(
      isHostManagedListener({ pid: 95, port: 1, commandLine: '/opt/orca/bin/x' }, config([]), 27)
    ).toBe(false)
  })
})
