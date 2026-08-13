import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../shared/pairing'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../shared/ephemeral-vm-runtime-store'
import * as runtimeEnvironmentStore from '../shared/runtime-environment-store'
import { resumeEphemeralVmRuntimeEnvironment } from './ephemeral-vm-runtime-environment-resume'

const tempDirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps a failed environment re-pair retryable', () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-vm-environment-resume-'))
  tempDirs.push(userDataPath)
  const runtime = upsertEphemeralVmRuntime(userDataPath, {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    runtimeEnvironmentId: 'environment-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      pairingCode: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: 'wss://runtime.example.com',
        deviceToken: 'token',
        publicKeyB64: 'public-key'
      }),
      projectRoot: '/workspace/repo'
    }
  })
  vi.spyOn(runtimeEnvironmentStore, 'updateEnvironmentFromPairingCode').mockImplementationOnce(
    () => {
      throw new Error('environment store unavailable')
    }
  )

  expect(() =>
    resumeEphemeralVmRuntimeEnvironment({
      userDataPath,
      environmentId: 'environment-1',
      runtime,
      invalidateTransport: vi.fn()
    })
  ).toThrow('environment store unavailable')
  expect(runtimeEnvironmentStore.listEnvironments(userDataPath)).toEqual([])
  expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
    status: 'resume_failed',
    resumeConnectionPending: true
  })
})
