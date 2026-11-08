import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { knownOrcadTunnelTransport } from '../../ssh/orcad-tunnel-transport-memo'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type { ForwardChannelVerdict } from '../../ssh/ssh-tcp-forwarding-probe'
import { OrcadManagedTunnelTransportProvider } from './orcad-managed-tunnel-transport'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the transport reads only the connect generation here.
const conn = { getConnectGeneration: () => 1 } as unknown as SshConnection

function startedFor(options: PortForwardStartOptions): StartedPortForward {
  return {
    entry: { ...options, localPort: 4100 },
    close: vi.fn(async () => {}),
    dispose: vi.fn()
  }
}

function provider(
  forwardStart: SshPortForwardProvider['start'],
  checkForward: (
    forward: StartedPortForward,
    options: { signal: AbortSignal }
  ) => Promise<ForwardChannelVerdict>
): { tunnel: OrcadManagedTunnelTransportProvider; bridgeStart: ReturnType<typeof vi.fn> } {
  const bridgeStart = vi.fn(async (_conn: SshConnection, options: PortForwardStartOptions) =>
    startedFor(options)
  )
  const tunnel = new OrcadManagedTunnelTransportProvider({
    forwards: [{ canHandle: () => true, start: forwardStart }],
    stdio: { canHandle: () => true, start: bridgeStart },
    probe: async () => 'unverifiable',
    checkForward,
    reserveLocalPort: async () => undefined
  })
  return { tunnel, bridgeStart }
}

const options = (connectionId: string): PortForwardStartOptions => ({
  id: 'pf',
  connectionId,
  localHost: '127.0.0.1',
  localPort: 0,
  remoteHost: '127.0.0.1',
  remotePort: 6768
})

describe('managed tunnel forward check', () => {
  it('stops waiting on the forward’s login once it exits, and bridges with its exit reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { tunnel, bridgeStart } = provider(
      async (_conn, forwardOptions) => {
        const started = startedFor(forwardOptions)
        setTimeout(() =>
          forwardOptions.onUnexpectedClose?.(started.entry, {
            kind: 'unexpected-exit',
            detail: 'Permission denied (publickey)'
          })
        )
        return started
      },
      // Models a login that would otherwise never bind: only the exit ends the wait.
      (_forward, { signal }) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve('not-listening')))
    )
    await tunnel.start(conn, options('exits'))
    expect(bridgeStart).toHaveBeenCalledTimes(1)
    expect(knownOrcadTunnelTransport('exits')).toBe('stdio_bridge')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('takes the stdio bridge: Permission denied (publickey)')
    )
    warn.mockRestore()
  })

  it('keeps a live forward whose channel answered', async () => {
    const { tunnel, bridgeStart } = provider(
      async (_conn, forwardOptions) => startedFor(forwardOptions),
      async (_forward, { signal }) => (signal.aborted ? 'not-listening' : 'allowed')
    )
    const started = await tunnel.start(conn, options('answers'))
    expect(bridgeStart).not.toHaveBeenCalled()
    expect(started.entry.localPort).toBe(4100)
    expect(knownOrcadTunnelTransport('answers')).toBe('tcp_forward')
  })
})
