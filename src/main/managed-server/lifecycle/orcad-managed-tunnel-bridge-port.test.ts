import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../ssh/ssh-connection'
import type { PortForwardStartOptions } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type * as ForwardProcess from '../../ssh/system-transport/system-ssh-forward-process'

const { reserveLocalForwardPort } = vi.hoisted(() => ({
  reserveLocalForwardPort: vi.fn(async (port: number, _orphanArgs?: readonly string[]) => port)
}))
vi.mock('../../ssh/system-transport/system-ssh-forward-process', async (importOriginal) => ({
  ...(await importOriginal<typeof ForwardProcess>()),
  reserveLocalForwardPort
}))

import { reserveBridgeLocalPort } from './orcad-managed-tunnel-transport'

const options: PortForwardStartOptions = {
  id: 'pf-1',
  connectionId: 'ssh-1',
  localHost: '127.0.0.1',
  localPort: 47123,
  remoteHost: '127.0.0.1',
  remotePort: 6768
}

function connection(systemSsh: boolean): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reservation reads only these three.
  return {
    usesSystemSshTransport: () => systemSsh,
    getTarget: () => ({ id: 't', label: 't', host: 'devbox', port: 22, username: 'me' }),
    getSystemSshBuildArgsOptions: () => ({})
  } as unknown as SshConnection
}

beforeEach(() => reserveLocalForwardPort.mockClear())

describe('the stdio bridge’s port reservation', () => {
  it('lets a system-SSH host clear an `ssh -L` an earlier Orca left on the port', async () => {
    await reserveBridgeLocalPort(connection(true), options)
    const orphanArgs = reserveLocalForwardPort.mock.calls[0]?.[1]
    expect(orphanArgs).toEqual(expect.arrayContaining(['-L', '127.0.0.1:47123:127.0.0.1:6768']))
    expect(orphanArgs).toContain('LogLevel=INFO')
  })

  it('never offers a kill on an ssh2 host, which never spawned one', async () => {
    await reserveBridgeLocalPort(connection(false), options)
    expect(reserveLocalForwardPort).toHaveBeenCalledWith(47123)
  })
})
