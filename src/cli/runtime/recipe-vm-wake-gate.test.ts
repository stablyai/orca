import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
// #36923: the CLI reaches a recipe VM's server directly, so it asks the desktop that owns the
// VM to wake it, and only for a command that opens the workspace.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtimes'
import { addEnvironmentFromPairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { prepareRecipeVmEnvironmentCall, type DesktopRecipeVmWake } from './recipe-vm-wake-gate'

const PAIRING_CODE = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'wss://sandbox.example.com',
  deviceToken: 'device-token',
  publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
})

let userDataPath = ''
let environmentId = ''

function recordVm(status: EphemeralVmRuntimeStatus): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'vm-1',
    recipeId: 'cloud-sandbox',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Fix Login Race',
    status,
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: { schemaVersion: 1, pairingCode: PAIRING_CODE, projectRoot: '/workspace/repo' },
    runtimeEnvironmentId: environmentId
  })
}

function prepare(method: string, answer: DesktopRecipeVmWake = 'up') {
  const askDesktopToWake = vi.fn(async (_environmentId: string) => answer)
  const prepared = prepareRecipeVmEnvironmentCall(userDataPath, 'sandbox', method, askDesktopToWake)
  return { prepared, askDesktopToWake }
}

describe('a CLI command for a recipe VM environment', () => {
  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-recipe-vm-'))
    environmentId = (
      await addEnvironmentFromPairingCode(userDataPath, {
        name: 'sandbox',
        pairingCode: PAIRING_CODE,
        source: 'ephemeral-vm'
      })
    ).id
  })

  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('says a suspended VM is asleep for a command that does not open its workspace', async () => {
    recordVm('suspended')
    const { prepared, askDesktopToWake } = prepare('worktree.ps')
    await expect(prepared).rejects.toMatchObject({ code: 'runtime_environment_asleep' })
    expect(askDesktopToWake).not.toHaveBeenCalled()
  })
})
