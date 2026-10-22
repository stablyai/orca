import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { PortForwardStartOptions } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type * as PortReservation from '../../ssh/system-transport/system-ssh-forward-port-reservation'

const { reserveLocalForwardPort, cancelMuxedLocalForward } = vi.hoisted(() => ({
  reserveLocalForwardPort: vi.fn(
    async (
      port: number,
      _orphanArgs?: readonly string[],
      _cancelMuxedForward?: () => Promise<boolean>
    ) => port
  ),
  cancelMuxedLocalForward: vi.fn(async () => true)
}))
vi.mock(
  '../../ssh/system-transport/system-ssh-forward-port-reservation',
  async (importOriginal) => ({
    ...(await importOriginal<typeof PortReservation>()),
    reserveLocalForwardPort
  })
)
vi.mock('../../ssh/system-transport/system-ssh-muxed-forward-cancel', () => ({
  cancelMuxedLocalForward
}))

import { reserveManagedTunnelLocalPort } from './orcad-managed-tunnel-transport'

const options: PortForwardStartOptions = {
  id: 'pf-1',
  connectionId: 'ssh-1',
  localHost: '127.0.0.1',
  localPort: 47123,
  remoteHost: '127.0.0.1',
  remotePort: 6768
}

/** A connection stubbed down to what the reservation reads: its transport and its ssh target. */
function connection(systemSsh: boolean): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reservation reads only these three.
  return {
    usesSystemSshTransport: () => systemSsh,
    getTarget: () => ({ id: 't', label: 't', host: 'devbox', port: 22, username: 'me' }),
    getSystemSshBuildArgsOptions: () => ({})
  } as unknown as SshConnection
}

beforeEach(() => {
  reserveLocalForwardPort.mockClear()
  cancelMuxedLocalForward.mockClear()
})

describe('the managed tunnel’s port reservation', () => {
  it('lets a system-SSH host clear an `ssh -L` an earlier Orca left on the port', async () => {
    await reserveManagedTunnelLocalPort(connection(true), options)
    const orphanArgs = reserveLocalForwardPort.mock.calls[0]?.[1]
    expect(orphanArgs).toEqual(expect.arrayContaining(['-L', '127.0.0.1:47123:127.0.0.1:6768']))
    expect(orphanArgs).toContain('LogLevel=INFO')
  })

  // Why: a forward made through a ControlMaster is left on the master, with no process to stop.
  it('lets a system-SSH host have that same forward cancelled on its ControlMaster', async () => {
    await reserveManagedTunnelLocalPort(connection(true), options)

    await reserveLocalForwardPort.mock.calls[0]?.[2]?.()
    expect(cancelMuxedLocalForward).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'devbox' }),
      47123,
      '127.0.0.1',
      6768,
      expect.anything()
    )
  })

  it('never offers a kill on an ssh2 host, which never spawned one', async () => {
    await reserveManagedTunnelLocalPort(connection(false), options)
    expect(reserveLocalForwardPort).toHaveBeenCalledWith(47123)
  })
})
