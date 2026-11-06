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
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-cli-recipe-vm-'))
    environmentId = addEnvironmentFromPairingCode(userDataPath, {
      name: 'sandbox',
      pairingCode: PAIRING_CODE,
      source: 'ephemeral-vm'
    }).id
  })

  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('goes straight to a running VM for a command that does not open its workspace', async () => {
    recordVm('running')
    const { prepared, askDesktopToWake } = prepare('worktree.ps')
    await expect(prepared).resolves.toBe('unchanged')
    expect(askDesktopToWake).not.toHaveBeenCalled()
  })

  // Only the desktop knows a sleep still suspending a VM whose record says running.
  // Even an "already up" answer may follow a concurrent wake that re-paired the server.
  it.each([
    ['up', 'reload'],
    ['unsupported', 'unchanged']
  ] as const)(
    'lets the desktop decide when opening a running VM workspace (desktop says %s)',
    async (answer, result) => {
      recordVm('running')
      const { prepared, askDesktopToWake } = prepare('worktree.activate', answer)
      await expect(prepared).resolves.toBe(result)
      expect(askDesktopToWake).toHaveBeenCalledWith(environmentId)
    }
  )

  it('asks the desktop to wake a suspended VM before opening its workspace', async () => {
    recordVm('suspended')
    const { prepared, askDesktopToWake } = prepare('worktree.activate')
    // The caller reads the server's pairing again, since the resume may have changed it.
    await expect(prepared).resolves.toBe('reload')
    expect(askDesktopToWake).toHaveBeenCalledWith(environmentId)
  })

  it('says a suspended VM is asleep for a command that does not open its workspace', async () => {
    recordVm('suspended')
    const { prepared, askDesktopToWake } = prepare('worktree.ps')
    await expect(prepared).rejects.toMatchObject({ code: 'runtime_environment_asleep' })
    expect(askDesktopToWake).not.toHaveBeenCalled()
  })

  it.each([
    ['unsupported', 'runtime_environment_asleep'],
    ['still-waking', 'runtime_environment_waking']
  ] as const)('reports a desktop answer of %s as %s', async (answer, code) => {
    recordVm('suspended')
    await expect(prepare('worktree.activate', answer).prepared).rejects.toMatchObject({ code })
  })
})
