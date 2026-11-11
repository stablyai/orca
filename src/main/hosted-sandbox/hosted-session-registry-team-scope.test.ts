import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { HostedEnvironmentProviderDriver } from './hosted-environment-provider'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import { createHostedSessionRegistry } from './hosted-session-registry'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, ipcMain: {}, BrowserWindow: {} }))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function record(id: string, cloudAccountId?: string): EphemeralVmRuntimeRecord {
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
    ...(cloudAccountId ? { cloudAccountId } : {}),
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
    }
  }
}

describe('hosted session registry team scope', () => {
  it("keeps only the active team's sandboxes alive; other and unfiled teams get no calls", async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-registry-team-'))
    dirs.push(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, record('mine', 'org:team-one'))
    upsertEphemeralVmRuntime(userDataPath, record('other', 'org:team-two'))
    upsertEphemeralVmRuntime(userDataPath, record('unfiled'))
    // A stopped answer ends start() before any scheduler or orcad call.
    const status = vi.fn(async (_handle: { environmentId: string }) => ({
      status: 'stopped',
      session: null
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sync reads only status().
    const driver = { status, capabilities: {} } as unknown as HostedEnvironmentProviderDriver
    let team = 'org:team-one'
    const running: boolean[] = []
    const registry = createHostedSessionRegistry({
      userDataPath,
      driver,
      windows: () => [],
      log: () => {},
      onRunningChange: (anyRunning) => running.push(anyRunning),
      activeAccountId: () => team
    })

    await registry.sync()
    expect(status.mock.calls.map(([handle]) => handle.environmentId)).toEqual(['sbx-mine'])

    team = 'org:team-two'
    status.mockClear()
    await registry.sync()
    expect(status.mock.calls.map(([handle]) => handle.environmentId)).toEqual(['sbx-other'])

    status.mockClear()
    team = 'org:team-three'
    await registry.sync()
    expect(status).not.toHaveBeenCalled()
    expect(running).toEqual([true, true, false])
    registry.dispose()
  })
})
