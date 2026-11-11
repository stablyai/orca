import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'

const userData = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
  BrowserWindow: { getAllWindows: () => [] }
}))
userData.path = mkdtempSync(join(tmpdir(), 'orca-pairings-'))
afterAll(() => rmSync(userData.path, { recursive: true, force: true }))

const { createCloudWorkspacesPairings } = await import('./cloud-workspaces-pairings')

function owned(id: string, sandboxId: string): EphemeralVmRuntimeRecord {
  return {
    id,
    recipeId: 'cloud',
    recipe: { id: 'cloud', name: 'Orca Cloud', create: 'c', provider: 'orca-cloud' },
    workspaceId: `ws-${id}`,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'code', projectRoot: '/p' },
      userData: {
        environmentDriver: {
          driverId: HOSTED_SANDBOX_DRIVER_ID,
          environmentId: sandboxId,
          driverState: { sandboxId }
        }
      }
    }
  }
}

describe('Delete from Home (LC-2)', () => {
  it("retires this desktop's own record of the deleted sandbox at once, and only that one", async () => {
    upsertEphemeralVmRuntime(userData.path, owned('lumpfish', 'sbx_aaaaaaaaaaaaaaaaaaaaaaaa'))
    upsertEphemeralVmRuntime(userData.path, owned('gudgeon', 'sbx_bbbbbbbbbbbbbbbbbbbbbbbb'))
    const { settleDeleted } = createCloudWorkspacesPairings(async () => null, undefined)

    await settleDeleted('sbx_aaaaaaaaaaaaaaaaaaaaaaaa')

    const byId = Object.fromEntries(
      listEphemeralVmRuntimes(userData.path).map((runtime) => [runtime.id, runtime.status])
    )
    expect(byId).toEqual({ lumpfish: 'cleaned', gudgeon: 'running' })
  })
})
