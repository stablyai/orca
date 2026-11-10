import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  resolveEnvironmentPairingOffer
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { DeviceRegistry } from '../runtime/rpc/server/pairing/device-registry'
import { applyResumedRuntimePairing } from './runtime-resume-pairing'

const hostKey = Buffer.alloc(32, 7).toString('base64')
const rotatedHostKey = Buffer.alloc(32, 9).toString('base64')
const unpaddedHostKey = Buffer.alloc(32, 7).toString('base64url')

/** Stands in for the VM's server: its state dir survives suspend, and each boot prints a startup offer. */
function bootVm(serverDataPath: string, endpoint: string, publicKeyB64 = hostKey): string {
  const offer = new DeviceRegistry(serverDataPath).getOrCreatePendingDevice('CLI', 'runtime')
  return encodePairingOffer({ v: 2, endpoint, deviceToken: offer.token, publicKeyB64 })
}

/** The server's answer to a saved token, as the desktop's connection would see it. */
function serverAuth(serverDataPath: string) {
  return async (connection: PairedRuntimeConnection): Promise<void> => {
    if (!new DeviceRegistry(serverDataPath).validateToken(connection.credential.deviceToken)) {
      throw new RemoteRuntimeClientError('unauthorized', 'rejected', {
        pairingStage: 'access-grant'
      })
    }
  }
}

/** The desktop connecting with its saved token, which marks that device row as used. */
function connect(serverDataPath: string, desktopDataPath: string, environmentId: string): void {
  const registry = new DeviceRegistry(serverDataPath)
  const { deviceToken } = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
  const device = registry.validateToken(deviceToken)
  if (!device) {
    throw new Error('saved device token was rejected')
  }
  registry.updateLastSeen(device.deviceId)
  registry.flushPendingLastSeen()
}

describe('resuming a recipe VM server', () => {
  let desktopDataPath: string
  let serverDataPath: string
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Why: store contents are under test; secure-file tests cover Windows ACLs.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    desktopDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-desktop-'))
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
  })
  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    rmSync(desktopDataPath, { recursive: true, force: true })
    rmSync(serverDataPath, { recursive: true, force: true })
  })

  function provision(): string {
    const environment = addEnvironmentFromPairingCode(desktopDataPath, {
      name: 'Cloud workspace',
      pairingCode: bootVm(serverDataPath, 'wss://vm-0.example/runtime'),
      source: 'ephemeral-vm'
    })
    connect(serverDataPath, desktopDataPath, environment.id)
    return environment.id
  }

  function resume(environmentId: string, pairingCode: string, invalidateTransport = vi.fn()) {
    return applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode,
      invalidateTransport,
      probeSavedPairing: serverAuth(serverDataPath)
    })
  }

  it('keeps the device rows flat and the original token across 20 suspend/resume cycles', async () => {
    const environmentId = provision()
    const original = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    const before = listEnvironments(desktopDataPath)[0]!
    const invalidateTransport = vi.fn()

    for (let cycle = 1; cycle <= 20; cycle++) {
      const endpoint = `wss://vm-${cycle}.example/runtime`
      const outcome = await resume(
        environmentId,
        bootVm(serverDataPath, endpoint),
        invalidateTransport
      )
      expect(outcome).toMatchObject({ reusedPairing: true, endpointChanged: true })
      expect(invalidateTransport).toHaveBeenCalledTimes(cycle)
      connect(serverDataPath, desktopDataPath, environmentId)
      expect(resolveEnvironmentPairingOffer(desktopDataPath, environmentId)).toMatchObject({
        endpoint,
        deviceToken: original.deviceToken
      })
    }

    // The paired device plus the one unused startup offer each boot re-advertises.
    expect(new DeviceRegistry(serverDataPath).listDevices()).toHaveLength(2)
    expect(listEnvironments(desktopDataPath)).toHaveLength(1)
    expect(listEnvironments(desktopDataPath)[0]!.pairingRevision).toBe(before.pairingRevision)
  })

  it('leaves the store untouched but still drops the transport when nothing moved', async () => {
    const environmentId = provision()
    const before = listEnvironments(desktopDataPath)[0]!
    const invalidateTransport = vi.fn()
    const outcome = await resume(
      environmentId,
      bootVm(serverDataPath, 'wss://vm-0.example/runtime'),
      invalidateTransport
    )
    expect(outcome).toMatchObject({ reusedPairing: true, endpointChanged: false })
    expect(listEnvironments(desktopDataPath)[0]).toEqual(before)
    expect(invalidateTransport).toHaveBeenCalledTimes(1)
    expect(invalidateTransport).toHaveBeenCalledWith(environmentId)
  })

  it('re-pairs from the fresh code when the host key changed, without asking the server', async () => {
    const environmentId = provision()
    const original = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    rmSync(serverDataPath, { recursive: true, force: true })
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
    const probeSavedPairing = vi.fn()

    const outcome = await applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode: bootVm(serverDataPath, 'wss://rebuilt.example/runtime', rotatedHostKey),
      invalidateTransport: vi.fn(),
      probeSavedPairing
    })

    expect(outcome.reusedPairing).toBe(false)
    expect(probeSavedPairing).not.toHaveBeenCalled()
    const next = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    expect(next.deviceToken).not.toBe(original.deviceToken)
    expect(next.publicKeyB64).toBe(rotatedHostKey)
    connect(serverDataPath, desktopDataPath, environmentId)
    expect(listEnvironments(desktopDataPath)).toHaveLength(1)
  })

  it('re-pairs from the fresh code when the server kept its key but lost the saved device', async () => {
    const environmentId = provision()
    const savedKeySpelling = resolveEnvironmentPairingOffer(
      desktopDataPath,
      environmentId
    ).publicKeyB64
    const original = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    const before = listEnvironments(desktopDataPath)[0]!
    rmSync(serverDataPath, { recursive: true, force: true })
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
    const invalidateTransport = vi.fn()

    const outcome = await resume(
      environmentId,
      // The same key, printed unpadded and URL-safe.
      bootVm(serverDataPath, 'wss://vm-1.example/runtime', unpaddedHostKey),
      invalidateTransport
    )

    expect(outcome.reusedPairing).toBe(false)
    const next = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    expect(next.deviceToken).not.toBe(original.deviceToken)
    expect(next.publicKeyB64).toBe(savedKeySpelling)
    expect(listEnvironments(desktopDataPath)[0]!.pairingRevision).not.toBe(before.pairingRevision)
    // Dialed alongside the probe, then again once the re-pair replaced the rejected token.
    expect(invalidateTransport).toHaveBeenCalledTimes(2)
    connect(serverDataPath, desktopDataPath, environmentId)
  })

  it('starts the reconnect before the saved-pairing probe answers', async () => {
    const environmentId = provision()
    const order: string[] = []
    await applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode: bootVm(serverDataPath, 'wss://vm-1.example/runtime'),
      invalidateTransport: () => order.push('invalidate'),
      probeSavedPairing: async () => {
        order.push('probe')
      }
    })
    expect(order).toEqual(['invalidate', 'probe'])
  })

  it('answers before the probe when confirming in the background, and re-pairs later if needed', async () => {
    const environmentId = provision()
    const before = listEnvironments(desktopDataPath)[0]!
    rmSync(serverDataPath, { recursive: true, force: true })
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
    const invalidateTransport = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const auth = serverAuth(serverDataPath)
    const repaired = new Promise<string>((resolve) => {
      void applyResumedRuntimePairing({
        userDataPath: desktopDataPath,
        environmentId,
        pairingCode: bootVm(serverDataPath, 'wss://vm-1.example/runtime', unpaddedHostKey),
        invalidateTransport,
        probeSavedPairing: async (connection) => {
          await gate
          return auth(connection)
        },
        confirmInBackground: true,
        onRepairedInBackground: (environment) => resolve(String(environment.pairingRevision))
      }).then((outcome) => {
        // Answered while the probe is still held: the kept pairing, transport already redialing.
        expect(outcome.reusedPairing).toBe(true)
        expect(invalidateTransport).toHaveBeenCalledTimes(1)
        release()
      })
    })
    expect(await repaired).not.toBe(String(before.pairingRevision))
    expect(invalidateTransport).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale background re-pair overwrite a newer resume', async () => {
    const environmentId = provision()
    rmSync(serverDataPath, { recursive: true, force: true })
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const auth = serverAuth(serverDataPath)
    const repairedA = vi.fn()
    const firstProbeSettled = Promise.withResolvers<void>()
    // Resume A: its probe is held, so its re-pair would land late.
    await applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode: bootVm(serverDataPath, 'wss://vm-a.example/runtime', unpaddedHostKey),
      invalidateTransport: vi.fn(),
      probeSavedPairing: async (connection) => {
        await firstGate
        try {
          return await auth(connection)
        } finally {
          firstProbeSettled.resolve()
        }
      },
      confirmInBackground: true,
      onRepairedInBackground: repairedA
    })
    // Resume B lands first and re-pairs synchronously (probe answers at once).
    const outcomeB = await applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode: bootVm(serverDataPath, 'wss://vm-b.example/runtime', unpaddedHostKey),
      invalidateTransport: vi.fn(),
      probeSavedPairing: auth
    })
    const afterB = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    releaseFirst()
    await firstProbeSettled.promise
    // Let A's confirmation chain (catch → guarded repair → then) run to the end.
    for (let tick = 0; tick < 10; tick++) {
      await Promise.resolve()
    }
    expect(repairedA).not.toHaveBeenCalled()
    expect(resolveEnvironmentPairingOffer(desktopDataPath, environmentId)).toEqual(afterB)
    expect(outcomeB.environment.id).toBe(environmentId)
  })

  it('keeps the saved pairing when the server cannot be reached to check it', async () => {
    const environmentId = provision()
    const original = resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    const outcome = await applyResumedRuntimePairing({
      userDataPath: desktopDataPath,
      environmentId,
      pairingCode: bootVm(serverDataPath, 'wss://vm-1.example/runtime'),
      invalidateTransport: vi.fn(),
      probeSavedPairing: async () => {
        throw new RemoteRuntimeClientError('runtime_unavailable', 'unreachable', {
          pairingStage: 'connect'
        })
      }
    })
    expect(outcome.reusedPairing).toBe(true)
    expect(resolveEnvironmentPairingOffer(desktopDataPath, environmentId).deviceToken).toBe(
      original.deviceToken
    )
  })
})
