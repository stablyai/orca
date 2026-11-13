import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../shared/testing/remove-temp-dirs.test-support'
import { removeTree } from '../../shared/windows-transient-lock-removal'
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
async function connect(
  serverDataPath: string,
  desktopDataPath: string,
  environmentId: string
): Promise<void> {
  const registry = new DeviceRegistry(serverDataPath)
  const { deviceToken } = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
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

  beforeEach(() => {
    desktopDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-desktop-'))
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
  })
  afterEach(async () => {
    await removeTempDirs([desktopDataPath, serverDataPath])
  })

  async function provision(): Promise<string> {
    const environment = await addEnvironmentFromPairingCode(desktopDataPath, {
      name: 'Cloud workspace',
      pairingCode: bootVm(serverDataPath, 'wss://vm-0.example/runtime'),
      source: 'ephemeral-vm'
    })
    await connect(serverDataPath, desktopDataPath, environment.id)
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
    const environmentId = await provision()
    const original = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    const before = (await listEnvironments(desktopDataPath))[0]!
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
      await connect(serverDataPath, desktopDataPath, environmentId)
      expect(await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)).toMatchObject({
        endpoint,
        deviceToken: original.deviceToken
      })
    }

    // The paired device plus the one unused startup offer each boot re-advertises.
    expect(new DeviceRegistry(serverDataPath).listDevices()).toHaveLength(2)
    expect(await listEnvironments(desktopDataPath)).toHaveLength(1)
    expect((await listEnvironments(desktopDataPath))[0]!.pairingRevision).toBe(
      before.pairingRevision
    )
  })

  it('leaves the store untouched but still drops the transport when nothing moved', async () => {
    const environmentId = await provision()
    const before = (await listEnvironments(desktopDataPath))[0]!
    const invalidateTransport = vi.fn()
    const outcome = await resume(
      environmentId,
      bootVm(serverDataPath, 'wss://vm-0.example/runtime'),
      invalidateTransport
    )
    expect(outcome).toMatchObject({ reusedPairing: true, endpointChanged: false })
    expect((await listEnvironments(desktopDataPath))[0]).toEqual(before)
    expect(invalidateTransport).toHaveBeenCalledWith(environmentId)
  })

  it('re-pairs from the fresh code when the host key changed, without asking the server', async () => {
    const environmentId = await provision()
    const original = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    await removeTree(serverDataPath)
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
    const next = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    expect(next.deviceToken).not.toBe(original.deviceToken)
    expect(next.publicKeyB64).toBe(rotatedHostKey)
    await connect(serverDataPath, desktopDataPath, environmentId)
    expect(await listEnvironments(desktopDataPath)).toHaveLength(1)
  })

  it('re-pairs from the fresh code when the server kept its key but lost the saved device', async () => {
    const environmentId = await provision()
    const savedKeySpelling = (await resolveEnvironmentPairingOffer(desktopDataPath, environmentId))
      .publicKeyB64
    const original = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    const before = (await listEnvironments(desktopDataPath))[0]!
    await removeTree(serverDataPath)
    serverDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-server-'))
    const invalidateTransport = vi.fn()

    const outcome = await resume(
      environmentId,
      // The same key, printed unpadded and URL-safe.
      bootVm(serverDataPath, 'wss://vm-1.example/runtime', unpaddedHostKey),
      invalidateTransport
    )

    expect(outcome.reusedPairing).toBe(false)
    const next = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
    expect(next.deviceToken).not.toBe(original.deviceToken)
    expect(next.publicKeyB64).toBe(savedKeySpelling)
    expect((await listEnvironments(desktopDataPath))[0]!.pairingRevision).not.toBe(
      before.pairingRevision
    )
    // Only once, after the probe: reconnecting earlier would dial with the rejected token.
    expect(invalidateTransport).toHaveBeenCalledTimes(1)
    await connect(serverDataPath, desktopDataPath, environmentId)
  })

  it('keeps the saved pairing when the server cannot be reached to check it', async () => {
    const environmentId = await provision()
    const original = await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)
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
    expect((await resolveEnvironmentPairingOffer(desktopDataPath, environmentId)).deviceToken).toBe(
      original.deviceToken
    )
  })
})
