import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const { installHostedWorkspaceService } = await import('./hosted-workspace-service')

const dirs: string[] = []
afterEach(() => {
  handlers.clear()
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

describe('hosted workspace service team scope', () => {
  it("polls and lists only the active team's cloud workspaces", async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-workspace-team-'))
    dirs.push(userDataPath)
    upsertEphemeralVmRuntime(userDataPath, record('mine', 'org:team-one'))
    upsertEphemeralVmRuntime(userDataPath, record('other', 'org:team-two'))
    upsertEphemeralVmRuntime(userDataPath, record('unfiled'))
    const workspaceStatus = vi.fn(async (_sandboxId: string) => ({ status: { metrics: null } }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: pollOom reads only workspaceStatus().
    const client = { workspaceStatus } as unknown as HostedSandboxControlPlaneClient
    const service = installHostedWorkspaceService({
      userDataPath,
      client,
      windows: () => [],
      syncSessions: () => {},
      stopSession: () => {},
      log: () => {},
      activeAccountId: () => 'org:team-one'
    })

    await service.pollOom()
    expect(workspaceStatus.mock.calls.map(([sandboxId]) => sandboxId)).toEqual(['sbx-mine'])
    const listIds = handlers.get('orcaCloudWorkspace:listIds')
    expect(await listIds?.()).toEqual(['ws-mine'])
  })
})
