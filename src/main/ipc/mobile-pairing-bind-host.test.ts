import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

import { registerMobileHandlers } from './mobile'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { WebSocketTransport } from '../runtime/rpc/ws-transport'

// Why its own file: shares the "runtime pairing bind host" fixtures below, split out of
// mobile.test.ts to stay under that file's line budget.
describe('runtime pairing bind host', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const wsTransportOf = (server: OrcaRuntimeRpcServer): WebSocketTransport | undefined =>
    (server['activeTransports'] as unknown[]).find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  const startServer = async (userDataPath: string, consent = () => false) => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      networkExposureConsent: consent
    })
    await server.start()
    return server
  }

  it('keeps a real listener on loopback for a local link and widens it only for an off-host one', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    let consentGranted = false // consent is granted mid-session, without a restart
    const server = await startServer(userDataPath, () => consentGranted)

    try {
      registerMobileHandlers(server)
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      await expect(
        handlers.get('mobile:getRuntimePairingUrl')?.(null, {
          address: '127.0.0.1',
          rotate: true,
          reach: 'this-computer'
        })
      ).resolves.toMatchObject({ available: true })
      // Why: the exposure regression — picking "This computer only" used to rebind the listener to
      // 0.0.0.0 and leave it there, publishing the runtime to the whole LAN for the rest of the process.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      consentGranted = true
      await expect(
        handlers.get('mobile:getRuntimePairingUrl')?.(null, {
          address: '100.64.1.20',
          rotate: true,
          reach: 'network'
        })
      ).resolves.toMatchObject({ available: true })
      // Why: the LAN/Tailscale choice still opts in — a client off this host cannot reach a loopback bind.
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })

  // Why: the whole guarantee is worthless if it lasts one process — the local web client authenticating
  // marks its grant lastSeenAt > 0, which used to make the NEXT launch bind every interface.
  it('still binds loopback on the next launch after the local link has been used', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = await startServer(userDataPath)
    let deviceId: string
    try {
      registerMobileHandlers(server)
      const offer = (await handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '127.0.0.1',
        rotate: true,
        reach: 'this-computer'
      })) as { available: true; deviceId: string }
      expect(offer.available).toBe(true)
      deviceId = offer.deviceId
      // Exactly what MobileSocketWiring does for every authenticated socket, local browser included.
      server.getDeviceRegistry()?.updateLastSeen(deviceId)
    } finally {
      await server.stop()
    }

    const relaunched = await startServer(userDataPath)
    try {
      expect(
        relaunched
          .getDeviceRegistry()
          ?.listDevices()
          .some((device) => device.deviceId === deviceId && device.lastSeenAt > 0)
      ).toBe(true)
      expect(wsTransportOf(relaunched)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await relaunched.stop()
    }
  })

  it('stays on loopback on the next launch after a network link was used, absent renewed consent', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = await startServer(userDataPath, () => true)
    try {
      registerMobileHandlers(server)
      const offer = (await handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        rotate: true,
        reach: 'network'
      })) as { available: true; deviceId: string }
      expect(offer.available).toBe(true)
      server.getDeviceRegistry()?.updateLastSeen(offer.deviceId)
    } finally {
      await server.stop()
    }

    // Why: pairing history isn't consent; a fresh process reads the setting fresh (default false).
    const relaunched = await startServer(userDataPath)
    try {
      expect(wsTransportOf(relaunched)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await relaunched.stop()
    }
  })
})
