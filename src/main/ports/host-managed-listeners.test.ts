import { describe, expect, it } from 'vitest'
import { hostManagedListenerConfig, isHostManagedListener } from './host-managed-listeners'

const config = (roots: string[] = ['/opt/orca'], unownedPorts: number[] = [23456]) => ({
  roots,
  unownedPorts: new Set(unownedPorts)
})

describe('host-managed listeners', () => {
  it('reads absolute roots and platform ports from the environment', async () => {
    const parsed = hostManagedListenerConfig({
      ORCA_HOST_MANAGED_LISTENER_PATHS: '/opt/orca/:relative:/srv/tools',
      ORCA_HOST_MANAGED_UNOWNED_PORTS: '23456, x,70000'
    })
    expect(parsed.roots).toEqual(['/opt/orca', '/srv/tools'])
    expect([...parsed.unownedPorts]).toEqual([23456])
    expect(hostManagedListenerConfig({})).toEqual({ roots: [], unownedPorts: new Set() })
  })

  it('marks the server itself and programs started from a managed root', async () => {
    expect(await isHostManagedListener({ pid: 27, port: 6768 }, config(), 27)).toBe(true)
    expect(
      await isHostManagedListener(
        { pid: 90, port: 2222, commandLine: '/opt/orca/openssh/sbin/sshd -D -f x' },
        config(),
        27
      )
    ).toBe(true)
    expect(
      await isHostManagedListener(
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

  it('marks a pid-less listener only on a declared platform port', async () => {
    expect(await isHostManagedListener({ port: 23456 }, config(), 27)).toBe(true)
    // A root-run postgres or Docker-published port has no visible pid but is the user's.
    expect(await isHostManagedListener({ port: 5432 }, config(), 27)).toBe(false)
    expect(await isHostManagedListener({ port: 23456 }, config(['/opt/orca'], []), 27)).toBe(false)
  })

  it('leaves user servers alone, matching by program path rather than port', async () => {
    expect(
      await isHostManagedListener(
        { pid: 92, port: 6768, commandLine: 'python3 -m http.server 6768' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      await isHostManagedListener(
        { pid: 92, port: 23456, commandLine: 'python3 -m http.server 23456' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      await isHostManagedListener(
        { pid: 93, port: 5173, commandLine: 'node vite --config /opt/orca/x.js' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      await isHostManagedListener(
        { pid: 94, port: 1, commandLine: '/opt/orcaother/bin/x' },
        config(),
        27
      )
    ).toBe(false)
    expect(
      await isHostManagedListener(
        { pid: 95, port: 1, commandLine: '/opt/orca/bin/x' },
        config([]),
        27
      )
    ).toBe(false)
  })

  it('walks ancestry to a managed tool, stopping at the server and at shells', async () => {
    const parents: Record<number, { pid: number; commandLine: string }> = {
      985: { pid: 941, commandLine: '/opt/orca/runtime/orcad/agent-browser-linux-x64' },
      1018: { pid: 985, commandLine: '/usr/bin/google-chrome --headless' },
      300: { pid: 27, commandLine: 'node /opt/orca/runtime/orcad/orcad-server.js' },
      400: { pid: 399, commandLine: '/bin/bash' },
      399: { pid: 27, commandLine: 'node /opt/orca/runtime/orcad/orcad-server.js' },
      500: { pid: 499, commandLine: '-bash' },
      499: { pid: 498, commandLine: '/opt/orca/openssh/sbin/sshd -D -f x' }
    }
    const read = async (pid: number) => parents[pid]
    const chrome = { pid: 985, port: 42063, commandLine: '/usr/bin/google-chrome --headless' }
    expect(await isHostManagedListener(chrome, config(), 27, read)).toBe(true)
    // Grandchild: a Chrome helper two levels below agent-browser.
    expect(
      await isHostManagedListener(
        { pid: 1018, port: 42064, commandLine: '/opt/google/chrome/chrome --type=utility' },
        config(),
        27,
        read
      )
    ).toBe(true)
    expect(await isHostManagedListener(chrome, config([]), 27, read)).toBe(false)
    const user = (pid: number) => ({ pid, port: 8123, commandLine: 'python3 -m http.server' })
    // `exec python3 -m http.server` in a terminal: its parent is the server.
    expect(await isHostManagedListener(user(300), config(), 27, read)).toBe(false)
    // Terminal shell under the server.
    expect(await isHostManagedListener(user(400), config(), 27, read)).toBe(false)
    // An SSH session's shell under the managed sshd.
    expect(await isHostManagedListener(user(500), config(), 27, read)).toBe(false)
  })
})
