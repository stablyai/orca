import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/pairing'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { fingerprintOrchestrationPeer } from '../../runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import { createOrchestrationEnvironmentTransport } from './orchestration-environment-transport'

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

describe('createOrchestrationEnvironmentTransport', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    vi.mocked(callRuntimeEnvironment).mockClear()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function newUserDataPath(): string {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-orchestration-transport-'))
    tempDirs.push(userDataPath)
    return userDataPath
  }

  function pairingCode(keyFill = 1): string {
    return encodePairingOffer({
      v: 2,
      endpoint: 'ws://192.0.2.10:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(keyFill)).toString('base64')
    })
  }

  function addPairedEnvironment(
    userDataPath: string
  ): ReturnType<typeof addEnvironmentFromPairingCode> {
    // A profile keypair different from the server's, so the self-pairing guard passes.
    mkdirSync(userDataPath, { recursive: true })
    const publicKeyB64 = Buffer.from(new Uint8Array(32).fill(2)).toString('base64')
    writeFileSync(
      join(userDataPath, 'orca-e2ee-keypair.json'),
      JSON.stringify({ v: 1, publicKeyB64, secretKeyB64: publicKeyB64 })
    )
    return addEnvironmentFromPairingCode(userDataPath, {
      name: 'build box',
      pairingCode: pairingCode()
    })
  }

  it('resolves a paired environment into the worker server the federation dials', () => {
    const userDataPath = newUserDataPath()
    const environment = addPairedEnvironment(userDataPath)
    const hostPublicKeyB64 = Buffer.from(new Uint8Array(32).fill(1)).toString('base64')

    const transport = createOrchestrationEnvironmentTransport(userDataPath)
    expect(transport.resolve(environment.id)).toEqual({
      environmentId: environment.id,
      name: 'build box',
      peerFingerprint: fingerprintOrchestrationPeer(hostPublicKeyB64),
      pairingRevision: environment.pairingRevision ?? environment.createdAt
    })
  })

  it('routes calls through the shared environment transport with the same registry root', async () => {
    const transport = createOrchestrationEnvironmentTransport('/user-data/root')
    const envelope = { orchestrationContractVersion: 9 } as const

    await transport.call(
      'env_windows',
      'orchestration.workerStart',
      { spec: 'echo' },
      5000,
      envelope,
      73
    )

    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data/root',
      'env_windows',
      'orchestration.workerStart',
      { spec: 'echo' },
      5000,
      73,
      envelope
    )
  })

  it('reads the registry root per call, as the desktop does around app.setName', async () => {
    let root = '/before-settle'
    const transport = createOrchestrationEnvironmentTransport(() => root)

    await transport.call('env_windows', 'status.get', undefined, 1000)
    expect(callRuntimeEnvironment).toHaveBeenLastCalledWith(
      '/before-settle',
      'env_windows',
      'status.get',
      undefined,
      1000,
      undefined,
      undefined
    )

    root = '/after-settle'
    await transport.call('env_windows', 'status.get', undefined, 1000)
    expect(callRuntimeEnvironment).toHaveBeenLastCalledWith(
      '/after-settle',
      'env_windows',
      'status.get',
      undefined,
      1000,
      undefined,
      undefined
    )
  })
})
