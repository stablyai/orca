import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'

const sent = vi.hoisted((): string[] => [])
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string) => sent.push(channel) } }
    ]
  }
}))

const { retireGoneCloudSandbox } = await import('./cloud-sandbox-gone-retire')

const dirs: string[] = []
afterEach(() => {
  sent.splice(0)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('retireGoneCloudSandbox', () => {
  it('cleans the record and asks the window to refresh its servers, which purges the project', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-gone-retire-'))
    dirs.push(userDataPath)
    const runtime = upsertEphemeralVmRuntime(userDataPath, {
      id: 'cusk',
      recipeId: 'orca-cloud',
      recipe: { id: 'orca-cloud', name: 'Orca Cloud', create: 'c', provider: 'orca-cloud' },
      runtimeEnvironmentId: 'env-cusk',
      status: 'resume_failed',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1
    })

    await retireGoneCloudSandbox(userDataPath, undefined, runtime)

    expect(listEphemeralVmRuntimes(userDataPath)[0]).toMatchObject({
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })
    expect(sent).toEqual(['runtimeEnvironments:catalogChanged'])
  })
})
