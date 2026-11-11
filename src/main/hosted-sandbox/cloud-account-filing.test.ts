import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  beginEphemeralVmProvisioning,
  endEphemeralVmProvisioning
} from '../ephemeral-vm/runtime-provisioning-persistence'
import { createCloudAccountBackfill } from './cloud-account-backfill'
import { ORCA_CLOUD_RECIPE } from './hosted-sandbox-recipe'
import { setOrcaCloudActiveAccountResolver } from './orca-cloud-active-account'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

const dirs: string[] = []
afterEach(() => {
  setOrcaCloudActiveAccountResolver(null)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-cloud-account-'))
  dirs.push(dir)
  return dir
}

function cloudRecord(
  id: string,
  sandboxId: string,
  cloudAccountId?: string
): EphemeralVmRuntimeRecord {
  return {
    id,
    recipeId: ORCA_CLOUD_RECIPE.id,
    recipe: {
      id: ORCA_CLOUD_RECIPE.id,
      name: 'Orca Cloud',
      create: 'orca-cloud create',
      provider: 'orca-cloud'
    },
    workspaceId: `ws-${id}`,
    runtimeEnvironmentId: `env-${id}`,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    ...(cloudAccountId ? { cloudAccountId } : {}),
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'orca-server',
        pairingCode: 'code',
        projectRoot: '/vercel/sandbox/project'
      },
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

function accountOf(path: string, id: string): string | undefined {
  return listEphemeralVmRuntimes(path).find((runtime) => runtime.id === id)?.cloudAccountId
}

describe('Orca Cloud team filing at create', () => {
  it('records the active team on an Orca Cloud runtime, read once at the write-ahead', () => {
    const path = userData()
    let team = 'org:team-one'
    setOrcaCloudActiveAccountResolver(() => team)
    const args = { userDataPath: path, repoPath: '/repo', recipe: ORCA_CLOUD_RECIPE }
    const writeAhead = beginEphemeralVmProvisioning(args)
    team = 'org:team-two'

    expect(accountOf(path, writeAhead.instanceId)).toBe('org:team-one')
    expect(writeAhead.cloudAccountId).toBe('org:team-one')
    endEphemeralVmProvisioning(args, writeAhead)
  })

  it('leaves recipe VMs that are not Orca Cloud unfiled', () => {
    const path = userData()
    setOrcaCloudActiveAccountResolver(() => 'org:team-one')
    const recipe = { id: 'vm', name: 'VM', create: 'make-vm' }
    const writeAhead = beginEphemeralVmProvisioning({ userDataPath: path, repoPath: '/r', recipe })
    expect(accountOf(path, writeAhead.instanceId)).toBeUndefined()
  })
})

describe('Orca Cloud team backfill', () => {
  it("files unfiled records the active team's list names, and only those", async () => {
    const path = userData()
    upsertEphemeralVmRuntime(path, cloudRecord('mine', 'sbx-mine'))
    upsertEphemeralVmRuntime(path, cloudRecord('other', 'sbx-other'))
    const list = vi.fn(async () => [{ id: 'sbx-mine' }])
    const backfill = createCloudAccountBackfill({
      userDataPath: path,
      activeAccountId: () => 'org:team-one',
      list
    })

    await backfill.run()
    expect(accountOf(path, 'mine')).toBe('org:team-one')
    expect(accountOf(path, 'other')).toBeUndefined()

    // Nothing new to file for this team: the beat does not list again.
    await backfill.run()
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('re-lists after a team switch and files that team, correcting a misfiled record', async () => {
    const path = userData()
    upsertEphemeralVmRuntime(path, cloudRecord('mine', 'sbx-mine', 'org:team-one'))
    upsertEphemeralVmRuntime(path, cloudRecord('other', 'sbx-other', 'org:team-one'))
    let team = 'org:team-one'
    const list = vi.fn(async () => (team === 'org:team-two' ? [{ id: 'sbx-other' }] : []))
    const backfill = createCloudAccountBackfill({
      userDataPath: path,
      activeAccountId: () => team,
      list
    })
    await backfill.run()
    team = 'org:team-two'
    await backfill.run()

    expect(list).toHaveBeenCalledTimes(2)
    expect(accountOf(path, 'other')).toBe('org:team-two')
    expect(accountOf(path, 'mine')).toBe('org:team-one')
  })

  it('files nothing when the team changed while listing', async () => {
    const path = userData()
    upsertEphemeralVmRuntime(path, cloudRecord('mine', 'sbx-mine'))
    let team = 'org:team-one'
    const backfill = createCloudAccountBackfill({
      userDataPath: path,
      activeAccountId: () => team,
      list: async () => {
        team = 'org:team-two'
        return [{ id: 'sbx-mine' }]
      }
    })
    await backfill.run()
    expect(accountOf(path, 'mine')).toBeUndefined()
  })

  it('does not list when signed out', async () => {
    const path = userData()
    upsertEphemeralVmRuntime(path, cloudRecord('mine', 'sbx-mine'))
    const list = vi.fn(async () => [])
    await createCloudAccountBackfill({
      userDataPath: path,
      activeAccountId: () => null,
      list
    }).run()
    expect(list).not.toHaveBeenCalled()
  })
})
