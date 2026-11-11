import { describe, expect, it } from 'vitest'
import { hostManagedListenerRoots, isHostManagedListener } from './host-managed-listeners'

describe('host-managed listeners', () => {
  it('reads absolute roots from the environment', () => {
    expect(
      hostManagedListenerRoots({
        ORCA_HOST_MANAGED_LISTENER_PATHS: '/opt/orca/:relative:/srv/tools'
      })
    ).toEqual(['/opt/orca', '/srv/tools'])
    expect(hostManagedListenerRoots({})).toEqual([])
  })

  it('marks the server itself and programs started from a managed root', () => {
    const roots = ['/opt/orca']
    expect(isHostManagedListener({ pid: 27 }, roots, 27)).toBe(true)
    expect(
      isHostManagedListener(
        { pid: 90, commandLine: '/opt/orca/openssh/sbin/sshd -D -f x' },
        roots,
        27
      )
    ).toBe(true)
    expect(
      isHostManagedListener(
        { pid: 91, commandLine: 'python3 /opt/orca/bin/orca-desktop-proxy --port 6080' },
        roots,
        27
      )
    ).toBe(true)
  })

  it('leaves user servers alone, including ones whose arguments mention a managed path later', () => {
    const roots = ['/opt/orca']
    expect(
      isHostManagedListener({ pid: 92, commandLine: 'python3 -m http.server 3000' }, roots, 27)
    ).toBe(false)
    expect(
      isHostManagedListener(
        { pid: 93, commandLine: 'node vite --config /opt/orca/x.js' },
        roots,
        27
      )
    ).toBe(false)
    expect(isHostManagedListener({ pid: 94, commandLine: '/opt/orcaother/bin/x' }, roots, 27)).toBe(
      false
    )
    expect(isHostManagedListener({ pid: 95, commandLine: '/opt/orca/bin/x' }, [], 27)).toBe(false)
  })
})
