// #36923: a client reaches a recipe VM's workspace through the VM's own server, which is gone
// while the VM sleeps. Opening the workspace wakes it; any other request leaves it asleep.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { upsertEphemeralVmRuntime } from '../../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeStatus } from '../../../shared/ephemeral-vm-runtimes'
import { registerRecipeVmWaker } from '../../runtime/workspaces/sleep/recipe-vm-waker-registry'
import type {
  RecipeVmOpening,
  RecipeVmState
} from '../../runtime/workspaces/sleep/recipe-vm-operations'
import { prepareRecipeVm } from './runtime-environment-recipe-vm-wake'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  forgetRecipeVmWakePairingsForTests,
  noteRecipeVmWakePairing
} from '../../ephemeral-vm/recipe-vm-wake-pairings'
import {
  clearRuntimeEnvironmentManualDisconnect,
  markRuntimeEnvironmentManuallyDisconnected
} from './runtime-environment-manual-disconnect'

const VM_ENVIRONMENT = { id: 'env-vm', source: 'ephemeral-vm' as const }
const SSH_VM_ENVIRONMENT = {
  id: 'env-ssh-vm',
  orcadDeployment: {
    sshTargetId: 'runtime-ssh-vm-2',
    sshTargetGeneration: 1,
    localPort: 41_000,
    remotePort: 6768
  }
}

let userDataPath = ''

// The wake owner's answers; they outrank the stored record, so the gate passes both through.
let ownerState: RecipeVmState | null = null
let ownerOpening: RecipeVmOpening = 'up'
const state = vi.fn(
  (_workspaceId: string, recordSuspended: boolean): RecipeVmState =>
    ownerState ?? (recordSuspended ? 'asleep' : 'up')
)
const holdOpen = vi.fn(
  async (_workspaceId: string, _recordSuspended: boolean, _timeoutMs: number) => ownerOpening
)

function recordVm(
  status: EphemeralVmRuntimeStatus,
  runtimeEnvironmentId = VM_ENVIRONMENT.id,
  id = 'vm-1'
): void {
  upsertEphemeralVmRuntime(userDataPath, {
    id,
    recipeId: 'cloud-sandbox',
    projectId: 'project-1',
    workspaceId: `workspace-of-${id}`,
    workspaceName: 'Fix Login Race',
    status,
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint: 'wss://sandbox.example.com',
        deviceToken: 'device-token',
        publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
      }),
      projectRoot: '/workspace/repo'
    },
    runtimeEnvironmentId
  })
}

async function codeOf(
  intent: 'wake' | 'none',
  environment: Parameters<typeof prepareRecipeVm>[1] = VM_ENVIRONMENT
): Promise<string | null> {
  try {
    await prepareRecipeVm(userDataPath, environment, intent)
    return null
  } catch (error) {
    return error instanceof RemoteRuntimeClientError ? error.code : 'uncoded'
  }
}

describe('a request to a recipe VM environment', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-recipe-vm-wake-'))
    ownerState = null
    ownerOpening = 'up'
    state.mockClear()
    holdOpen.mockClear()
    registerRecipeVmWaker({
      state,
      noteOpened: vi.fn(),
      holdOpen,
      openEnvironment: async () => 'up'
    })
  })

  afterEach(() => {
    registerRecipeVmWaker(null)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it.each(['suspended', 'resume_failed'] as const)(
    'leaves a %s VM asleep for a request that does not open its workspace',
    async (status) => {
      recordVm(status)
      await expect(codeOf('none')).resolves.toBe('runtime_environment_asleep')
      expect(state).toHaveBeenCalledWith('workspace-of-vm-1', true)
      expect(holdOpen).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['waking', 'runtime_environment_waking'],
    ['asleep', 'runtime_environment_asleep']
  ] as const)(
    "answers from the owner's %s state though the record says running",
    async (owner, code) => {
      recordVm('running')
      ownerState = owner
      await expect(codeOf('none')).resolves.toBe(code)
    }
  )

  // A phone gives up after 30 seconds, so its open is held for less.

  // A Disconnect made before the open holds: no client's open wakes the VM behind that server.
  it('refuses an open of a server the user disconnected, before waking anything', async () => {
    recordVm('suspended')
    markRuntimeEnvironmentManuallyDisconnected(VM_ENVIRONMENT.id)
    try {
      await expect(codeOf('wake')).resolves.toBe('runtime_manually_disconnected')
      expect(holdOpen).not.toHaveBeenCalled()
    } finally {
      clearRuntimeEnvironmentManualDisconnect(VM_ENVIRONMENT.id)
    }
  })

  // The fence after a wake is the pairing that wake made, never whatever is current afterwards.
  it('reports the pairing a wake made while the open was held, and nothing otherwise', async () => {
    recordVm('suspended')
    forgetRecipeVmWakePairingsForTests()
    holdOpen.mockImplementationOnce(async () => {
      noteRecipeVmWakePairing(VM_ENVIRONMENT.id, 7)
      return 'up'
    })
    await expect(prepareRecipeVm(userDataPath, VM_ENVIRONMENT, 'wake')).resolves.toEqual({
      wokenPairingRevision: 7
    })
    // A later open that woke nothing does not inherit that pairing.
    await expect(prepareRecipeVm(userDataPath, VM_ENVIRONMENT, 'wake')).resolves.toEqual({
      wokenPairingRevision: null
    })
  })

  it('cancels an open the user disconnected while it waited, without stopping the wake', async () => {
    recordVm('suspended')
    holdOpen.mockImplementationOnce(async () => {
      markRuntimeEnvironmentManuallyDisconnected(VM_ENVIRONMENT.id)
      return 'up'
    })
    try {
      await expect(codeOf('wake')).resolves.toBe('runtime_manually_disconnected')
    } finally {
      clearRuntimeEnvironmentManualDisconnect(VM_ENVIRONMENT.id)
    }
  })

  it("finds an SSH-connected VM by its runtime-owned target's environment", async () => {
    recordVm('suspended', SSH_VM_ENVIRONMENT.id, 'vm-2')
    await expect(codeOf('wake', SSH_VM_ENVIRONMENT)).resolves.toBeNull()
    expect(holdOpen).toHaveBeenCalledWith('workspace-of-vm-2', true, 180_000, undefined)
  })

  it('never treats a user-paired server as a VM, even under a recorded id', async () => {
    recordVm('suspended', 'env-manual')
    await expect(codeOf('none', { id: 'env-manual', source: 'manual' })).resolves.toBeNull()
    expect(state).not.toHaveBeenCalled()
  })
})
