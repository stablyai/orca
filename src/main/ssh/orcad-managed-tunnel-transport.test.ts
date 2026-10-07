import { describe, expect, it, vi } from 'vitest'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import { knownOrcadTunnelTransport } from './orcad-tunnel-transport-memo'
import type { SshConnection } from './ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import type { TcpForwardingVerdict } from './ssh-tcp-forwarding-probe'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector passes the connection through untouched.
const conn = {} as SshConnection
const options: PortForwardStartOptions = {
  id: 'pf-1',
  connectionId: 'ssh-1',
  localHost: '127.0.0.1',
  localPort: 46_001,
  remoteHost: '127.0.0.1',
  remotePort: 6768
}

function provider(name: string, canHandle = true): SshPortForwardProvider & { name: string } {
  return {
    name,
    canHandle: () => canHandle,
    start: vi.fn(async () => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only which provider answered.
      return { entry: { id: name } } as unknown as StartedPortForward
    })
  }
}

function select(verdict: TcpForwardingVerdict) {
  const forward = provider('forward')
  const stdio = provider('stdio')
  const transport = new OrcadManagedTunnelTransportProvider({
    forwards: [provider('unusable', false), forward],
    stdio,
    probe: vi.fn(async () => verdict)
  })
  return { transport, forward, stdio }
}

describe('the managed tunnel’s transport', () => {
  it('takes the stdio bridge only where sshd refuses forwarding', async () => {
    const refused = select('refused')
    await expect(refused.transport.start(conn, options)).resolves.toMatchObject({
      entry: { id: 'stdio' }
    })
    expect(refused.stdio.start).toHaveBeenCalledWith(conn, options)
    expect(refused.forward.start).not.toHaveBeenCalled()
    expect(knownOrcadTunnelTransport('ssh-1')).toBe('stdio_bridge')
  })

  it('keeps the forward when forwarding is allowed or the answer is unverifiable', async () => {
    for (const verdict of ['allowed', 'unverifiable'] as const) {
      const chosen = select(verdict)
      await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
        entry: { id: 'forward' }
      })
      expect(chosen.stdio.start).not.toHaveBeenCalled()
      expect(knownOrcadTunnelTransport('ssh-1')).toBe('tcp_forward')
    }
  })
})
