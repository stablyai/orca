import { describe, expect, it, vi } from 'vitest'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { BrowserTunnelDestinationBlockedError } from '../../../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import {
  connectPairedPortForwardTarget,
  createNetworkPortForwardMethods
} from './network-port-forward'

function runtime(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only these accessors; OrcaRuntimeService is a class, so a structural double cannot satisfy it without the cast.
  return {
    getRuntimeId: () => 'runtime-a',
    registerSubscriptionCleanup: () => {}
  } as unknown as OrcaRuntimeService
}

const request = {
  id: 'port-forward',
  authToken: 'bound-by-websocket',
  method: 'network.portForward',
  params: {}
}

describe('network.portForward', () => {
  it('dials only the host’s own loopback, whatever the client names', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard only passes the returned socket through; this test never uses it.
    const connect = vi.fn(() => ({}) as never)
    for (const host of [
      '10.0.0.5',
      '169.254.169.254',
      'metadata.google.internal',
      'app.localhost',
      'localhost.example.com',
      '127.0.0.1.nip.io',
      '127.0.0.2',
      '0.0.0.0',
      '::',
      '2130706433'
    ]) {
      expect(() => connectPairedPortForwardTarget({ host, port: 5173 }, connect)).toThrow(
        BrowserTunnelDestinationBlockedError
      )
    }
    expect(connect).not.toHaveBeenCalled()

    for (const [host, dialed] of [
      ['localhost', 'localhost'],
      ['LOCALHOST', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['::1', '::1'],
      ['[::1]', '::1']
    ] as const) {
      connectPairedPortForwardTarget({ host, port: 5173 }, connect)
      expect(connect).toHaveBeenLastCalledWith({ host: dialed, port: 5173 })
    }
  })

  it('refuses phones, local callers and clients that did not negotiate forwarding', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: createNetworkPortForwardMethods()
    })
    const desktop = {
      connectionId: 'connection-a',
      clientKind: 'runtime' as const,
      pairedDeviceId: 'device-a',
      clientCapabilities: [NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY],
      sendBinary: vi.fn(() => true)
    }
    for (const [context, error] of [
      [{ ...desktop, clientKind: 'mobile' as const }, 'authenticated_binary_port_forward_required'],
      [{ ...desktop, pairedDeviceId: undefined }, 'authenticated_binary_port_forward_required'],
      [{ ...desktop, clientCapabilities: [] }, 'port_forward_capability_required']
    ] as const) {
      const registerBinaryMessageHandler = vi.fn()
      const replies: string[] = []
      await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), {
        ...context,
        registerBinaryMessageHandler
      })
      expect(JSON.parse(replies[0]!).error.message).toBe(error)
      expect(registerBinaryMessageHandler).not.toHaveBeenCalled()
    }
  })
})
