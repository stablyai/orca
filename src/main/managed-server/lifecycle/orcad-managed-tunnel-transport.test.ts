import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import { knownOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type { TcpForwardingVerdict } from '../../ssh/ssh-tcp-forwarding-probe'

let generation = 1
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selector reads only the transport generation.
const conn = { getConnectGeneration: () => generation } as unknown as SshConnection
const options: PortForwardStartOptions = {
  id: 'pf-1',
  connectionId: 'ssh-1',
  localHost: '127.0.0.1',
  localPort: 46_001,
  remoteHost: '127.0.0.1',
  remotePort: 6768
}

function provider(name: string, canHandle = true) {
  const close = vi.fn(async () => {})
  return {
    name,
    close,
    canHandle: () => canHandle,
    start: vi.fn(async (_conn: SshConnection, _options: PortForwardStartOptions) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only which provider answered.
      return { entry: { id: name }, close } as unknown as StartedPortForward
    })
  } satisfies SshPortForwardProvider & { name: string; close: unknown }
}

function select(
  verdict: TcpForwardingVerdict,
  channel: TcpForwardingVerdict = 'unverifiable',
  stdioCanHandle = true
) {
  const forward = provider('forward')
  const stdio = provider('stdio', stdioCanHandle)
  const reserveLocalPort = vi.fn(async () => {})
  const checkForward = vi.fn(async () => channel)
  const transport = new OrcadManagedTunnelTransportProvider({
    forwards: [provider('unusable', false), forward],
    stdio,
    probe: vi.fn(async () => verdict),
    checkForward,
    reserveLocalPort
  })
  return { transport, forward, stdio, checkForward, reserveLocalPort }
}

beforeEach(() => {
  generation = 1
})

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

  it('replaces a system SSH forward whose channel sshd refused with the stdio bridge', async () => {
    // System SSH has no ssh2 client to probe, so only the forward's own channel check can tell.
    const chosen = select('unverifiable', 'refused')
    await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
      entry: { id: 'stdio' }
    })
    expect(chosen.forward.close).toHaveBeenCalledOnce()
    expect(chosen.forward.close.mock.invocationCallOrder[0]).toBeLessThan(
      chosen.stdio.start.mock.invocationCallOrder[0]
    )
    expect(chosen.stdio.start).toHaveBeenCalledWith(conn, options)
    // The closed forward's ssh must have released the persisted port before the bridge binds it.
    expect(chosen.reserveLocalPort.mock.invocationCallOrder[0]).toBeGreaterThan(
      chosen.forward.close.mock.invocationCallOrder[0]
    )
    expect(chosen.reserveLocalPort.mock.invocationCallOrder[0]).toBeLessThan(
      chosen.stdio.start.mock.invocationCallOrder[0]
    )
    expect(knownOrcadTunnelTransport('ssh-1')).toBe('stdio_bridge')
  })

  it('fails loudly, never with the dead forward, when a refused host has no bridge route', async () => {
    const chosen = select('unverifiable', 'refused', false)
    await expect(chosen.transport.start(conn, options)).rejects.toThrow(/refuses TCP forwarding/)
    expect(chosen.forward.close).toHaveBeenCalledOnce()
  })

  it('keeps a forward whose channel opened or whose answer is unverifiable', async () => {
    for (const channel of ['allowed', 'unverifiable'] as const) {
      const chosen = select('unverifiable', channel)
      await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
        entry: { id: 'forward' }
      })
      expect(chosen.forward.close).not.toHaveBeenCalled()
      expect(chosen.stdio.start).not.toHaveBeenCalled()
    }
  })

  it('goes straight to the bridge on the transport that refused, and re-checks after a reconnect', async () => {
    const chosen = select('unverifiable', 'refused')
    await chosen.transport.start(conn, options)
    await chosen.transport.start(conn, options)
    expect(chosen.forward.start).toHaveBeenCalledOnce()
    expect(chosen.stdio.start).toHaveBeenCalledTimes(2)
    // A stale `ssh -L` from an earlier Orca may still hold the persisted port.
    expect(chosen.reserveLocalPort).toHaveBeenCalledWith(conn, options)

    generation = 2
    await chosen.transport.start(conn, options)
    expect(chosen.forward.start).toHaveBeenCalledTimes(2)
  })

  it('fails, rather than hand back a dead forward, when the forward exits during its check', async () => {
    const chosen = select('unverifiable')
    chosen.checkForward.mockImplementation(async () => {
      const entry = { ...options, localPort: options.localPort }
      chosen.forward.start.mock.calls[0]?.[1].onUnexpectedClose?.(entry, {
        kind: 'unexpected-exit',
        detail: 'System SSH port forward failed (exit 255)'
      })
      return 'unverifiable'
    })
    await expect(chosen.transport.start(conn, options)).rejects.toThrow(/exit 255/)
  })

  it('never records a refusal answered before a reconnect against the new transport', async () => {
    const chosen = select('unverifiable', 'refused')
    chosen.checkForward.mockImplementationOnce(async () => {
      generation = 2
      return 'refused'
    })
    await chosen.transport.start(conn, options)
    chosen.checkForward.mockResolvedValue('allowed')
    await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
      entry: { id: 'forward' }
    })
    expect(chosen.forward.start).toHaveBeenCalledTimes(2)
  })
})
