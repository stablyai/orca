import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { createCloudAccountBackfill } from './cloud-account-backfill'
import { createCloudSandboxGonePrune } from './cloud-sandbox-gone-prune'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const TEAM = 'org:team-one'

function record(
  id: string,
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id,
    recipeId: 'orca-cloud',
    recipe: { id: 'orca-cloud', name: 'Orca Cloud', create: 'c', provider: 'orca-cloud' },
    workspaceId: `ws-${id}`,
    runtimeEnvironmentId: `env-${id}`,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    cloudAccountId: TEAM,
    recipeResult: {
      schemaVersion: 1,
      connection: { type: 'orca-server', pairingCode: 'code', projectRoot: '/p' },
      userData: {
        environmentDriver: {
          driverId: HOSTED_SANDBOX_DRIVER_ID,
          environmentId: `sbx-${id}`,
          driverState: { sandboxId: `sbx-${id}` }
        }
      }
    },
    ...overrides
  }
}

function setup(
  records: EphemeralVmRuntimeRecord[],
  get: (id: string) => Promise<{ status: string }>
) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-gone-prune-'))
  dirs.push(userDataPath)
  records.forEach((entry) => upsertEphemeralVmRuntime(userDataPath, entry))
  let team: string | null = TEAM
  const retired: string[] = []
  const prune = createCloudSandboxGonePrune({
    userDataPath,
    activeAccountId: () => team,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prune reads only status.
    get: get as never,
    retire: async (runtime) => void retired.push(runtime.id)
  })
  return {
    prune,
    retired,
    userDataPath,
    switchTeam: (next: string | null) => {
      team = next
    }
  }
}

const notFound = async (): Promise<never> => {
  throw new EnvironmentProviderError('not_found', 'no such sandbox')
}
const offline = async (): Promise<never> => {
  throw new EnvironmentProviderError('unavailable', 'offline')
}

describe('Orca Cloud gone-sandbox prune', () => {
  it('retires a sandbox missing from the list once its own read says not found', async () => {
    const h = setup([record('cusk'), record('crayfish')], notFound)
    await h.prune.observeList(TEAM, new Set(['sbx-crayfish']))
    expect(h.retired).toEqual(['cusk'])
  })

  it('retires on a destroyed answer, or on a second consecutive list without it', async () => {
    const destroyed = setup([record('cusk')], async () => ({ status: 'destroyed' }))
    await destroyed.prune.observeList(TEAM, new Set())
    expect(destroyed.retired).toEqual(['cusk'])

    const twice = setup([record('cusk')], offline)
    await twice.prune.observeList(TEAM, new Set())
    expect(twice.retired).toEqual([])
    await twice.prune.observeList(TEAM, new Set())
    expect(twice.retired).toEqual(['cusk'])
  })

  it('keeps it through a network blip: one miss plus an unreadable sandbox is not proof', async () => {
    const h = setup([record('cusk')], offline)
    await h.prune.observeList(TEAM, new Set())
    // Listed again: the miss streak resets, so a later single miss is not a second one.
    await h.prune.observeList(TEAM, new Set(['sbx-cusk']))
    await h.prune.observeList(TEAM, new Set())
    expect(h.retired).toEqual([])
  })

  it('keeps a sandbox still being created, which the list may not show yet', async () => {
    const h = setup([record('cusk', { status: 'provisioning' })], notFound)
    await h.prune.observeList(TEAM, new Set())
    await h.prune.observeList(TEAM, new Set())
    expect(h.retired).toEqual([])
  })

  it("keeps another team's sandbox, and one whose team is unknown", async () => {
    const h = setup(
      [
        record('otter', { cloudAccountId: 'org:team-two' }),
        record('legacy', { cloudAccountId: undefined })
      ],
      notFound
    )
    await h.prune.observeList(TEAM, new Set())
    await h.prune.observeList(TEAM, new Set())
    expect(h.retired).toEqual([])
  })

  it('never retires an asleep (suspended or archived) sandbox the team still lists', async () => {
    const get = vi.fn(async () => ({ status: 'suspended' }))
    const h = setup([record('asleep', { status: 'suspended' }), record('archived')], get)
    for (let round = 0; round < 3; round++) {
      await h.prune.observeList(TEAM, new Set(['sbx-asleep', 'sbx-archived']))
    }
    expect(h.retired).toEqual([])
    expect(get).not.toHaveBeenCalled()
  })

  it('drops the confirmation when the team switched while it was read', async () => {
    const h = setup([record('cusk')], async () => {
      h.switchTeam('org:team-two')
      throw new EnvironmentProviderError('not_found', 'gone')
    })
    await h.prune.observeList(TEAM, new Set())
    expect(h.retired).toEqual([])
  })
})

describe('Orca Cloud list reconcile', () => {
  it('reconciles at startup and on each re-list, but never on a failed list', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-gone-reconcile-'))
    dirs.push(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, record('cusk'))
    let clock = 0
    let fail = true
    const onListed = vi.fn(async () => {})
    const backfill = createCloudAccountBackfill({
      userDataPath,
      activeAccountId: () => TEAM,
      list: async () => {
        if (fail) {
          throw new EnvironmentProviderError('unavailable', 'offline')
        }
        return []
      },
      onListed,
      relistMs: 1_000,
      now: () => clock
    })

    await backfill.run()
    expect(onListed).not.toHaveBeenCalled()
    fail = false
    await backfill.run()
    expect(onListed).toHaveBeenCalledTimes(1)
    await backfill.run()
    expect(onListed).toHaveBeenCalledTimes(1)
    clock = 1_000
    await backfill.run()
    expect(onListed).toHaveBeenCalledTimes(2)
  })

  it('a forced run lists now, so a sandbox deleted elsewhere is pruned without waiting (LC-2)', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-gone-force-'))
    dirs.push(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, record('lumpfish'))
    const onListed = vi.fn(async () => {})
    const backfill = createCloudAccountBackfill({
      userDataPath,
      activeAccountId: () => TEAM,
      list: async () => [],
      onListed,
      relistMs: 10 * 60_000,
      now: () => 0
    })
    await backfill.run()
    await backfill.run()
    expect(onListed).toHaveBeenCalledTimes(1)
    await backfill.run({ force: true })
    expect(onListed).toHaveBeenCalledTimes(2)
  })
})
