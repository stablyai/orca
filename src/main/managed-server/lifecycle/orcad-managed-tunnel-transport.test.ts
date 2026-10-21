import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'
import { knownOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type {
  ForwardChannelVerdict,
  TcpForwardingVerdict
} from '../../ssh/ssh-tcp-forwarding-probe'

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
  channel: ForwardChannelVerdict = 'unverifiable',
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
    expect(chosen.reserveLocalPort.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      chosen.forward.close.mock.invocationCallOrder[0]
    )
    expect(chosen.reserveLocalPort.mock.invocationCallOrder.at(-1)).toBeLessThan(
      chosen.stdio.start.mock.invocationCallOrder[0]
    )
    expect(knownOrcadTunnelTransport('ssh-1')).toBe('stdio_bridge')
  })

  it('fails loudly, never with the dead forward, when a refused host has no bridge route', async () => {
    const chosen = select('unverifiable', 'refused', false)
    await expect(chosen.transport.start(conn, options)).rejects.toThrow(
      /has no route: sshd refused/
    )
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

  it('takes the bridge, never the dead forward, when the forward exits during its check', async () => {
    const chosen = select('unverifiable')
    const onUnexpectedClose = vi.fn()
    chosen.checkForward.mockImplementation(async () => {
      chosen.forward.start.mock.calls[0]?.[1].onUnexpectedClose?.(options, {
        kind: 'unexpected-exit',
        detail: 'System SSH port forward failed (exit 255): Permission denied (publickey).'
      })
      return 'unverifiable'
    })
    await expect(
      chosen.transport.start(conn, { ...options, onUnexpectedClose })
    ).resolves.toMatchObject({ entry: { id: 'stdio' } })
    expect(chosen.forward.close).toHaveBeenCalledOnce()
    expect(knownOrcadTunnelTransport('ssh-1')).toBe('stdio_bridge')
    // A late exit of the abandoned forward must not read as the bridge closing.
    chosen.forward.start.mock.calls[0]?.[1].onUnexpectedClose?.(options, {
      kind: 'unexpected-exit'
    })
    expect(onUnexpectedClose).toHaveBeenCalledOnce()
  })

  it('reports ssh’s own exit reason over a listener that never came up', async () => {
    const chosen = select('unverifiable', 'not-listening', false)
    chosen.checkForward.mockImplementation(async () => {
      chosen.forward.start.mock.calls[0]?.[1].onUnexpectedClose?.(options, {
        kind: 'unexpected-exit',
        detail: 'Permission denied (publickey).'
      })
      return 'not-listening'
    })
    await expect(chosen.transport.start(conn, options)).rejects.toThrow(/Permission denied/)
  })

  // Why: a ControlMaster can hold a login (MFA, a hardware key) the forward cannot repeat alone.
  it('takes the bridge when the forward fails to start at all', async () => {
    const chosen = select('unverifiable')
    chosen.forward.start.mockRejectedValueOnce(
      new Error('System SSH port forward failed (exit 255): Permission denied (publickey).')
    )
    await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
      entry: { id: 'stdio' }
    })
    expect(chosen.stdio.start).toHaveBeenCalledWith(conn, options)
    expect(chosen.checkForward).not.toHaveBeenCalled()
    expect(knownOrcadTunnelTransport('ssh-1')).toBe('stdio_bridge')
    await chosen.transport.start(conn, options)
    expect(chosen.forward.start).toHaveBeenCalledOnce()
  })

  // Why: a forward still waiting on a key touch or a prompt never binds, yet has not exited.
  it('takes the bridge when the forward never listened', async () => {
    const chosen = select('unverifiable', 'not-listening')
    await expect(chosen.transport.start(conn, options)).resolves.toMatchObject({
      entry: { id: 'stdio' }
    })
    expect(chosen.forward.close).toHaveBeenCalledOnce()
  })

  it('frees the persisted port before the forward binds it, not only before the bridge', async () => {
    const chosen = select('unverifiable', 'allowed')
    await chosen.transport.start(conn, options)
    expect(chosen.reserveLocalPort).toHaveBeenCalledWith(conn, options)
    expect(chosen.reserveLocalPort.mock.invocationCallOrder[0]).toBeLessThan(
      chosen.forward.start.mock.invocationCallOrder[0]
    )
  })

  it('reserves nothing for a port OpenSSH picks itself', async () => {
    const chosen = select('unverifiable', 'refused')
    await chosen.transport.start(conn, { ...options, localPort: 0 })
    expect(chosen.reserveLocalPort).not.toHaveBeenCalled()
  })

  it('surfaces the bridge’s own failure when neither route starts', async () => {
    const chosen = select('unverifiable')
    chosen.forward.start.mockRejectedValueOnce(new Error('forward login refused'))
    chosen.stdio.start.mockRejectedValueOnce(new Error('bridge unavailable'))
    await expect(chosen.transport.start(conn, options)).rejects.toThrow('bridge unavailable')
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
