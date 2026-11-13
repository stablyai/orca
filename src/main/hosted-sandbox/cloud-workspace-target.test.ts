import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => undefined)
}))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteCloudPairingBindings } from '../cloud-workspaces/cloud-paired-environment-ids'
import { restartPairedCloudSandbox, restartPairedOrNotCloud } from './cloud-workspace-target'

afterEach(() => {
  noteCloudPairingBindings({})
})

describe('Restart for a paired cloud workspace (PAIRED-WAKE 2/2)', () => {
  it('restarts its sandbox, reconnects only its server, and reports waking → connecting → ready', async () => {
    noteCloudPairingBindings({
      sbx_gh: { environmentId: 'env-gh' },
      sbx_other: { environmentId: 'env-other' }
    })
    const restart = vi.fn(async () => undefined)
    const invalidate = vi.fn(async () => undefined)
    const phases: string[] = []
    const result = await restartPairedCloudSandbox({
      workspaceId: 'row',
      sandboxId: 'sbx_gh',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `restart` is called, and its answer is ignored.
      client: { restart } as never,
      emit: (event) => phases.push(event.phase),
      invalidate
    })
    expect(result).toEqual({ ok: true, value: null })
    expect(restart).toHaveBeenCalledWith('sbx_gh')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith('env-gh')
    expect(phases).toEqual(['waking', 'connecting', 'ready'])
  })

  it('a refused restart reports failed and passes the error back', async () => {
    const phases: string[] = []
    const result = await restartPairedCloudSandbox({
      workspaceId: 'row',
      sandboxId: 'sbx_gh',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `restart` is called.
      client: {
        restart: async () => {
          throw new Error('nope')
        }
      } as never,
      emit: (event) => phases.push(event.phase)
    })
    expect(result).toMatchObject({ ok: false })
    expect(phases).toEqual(['waking', 'failed'])
  })

  it('a workspace that is neither owned nor bound here is not cloud', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-paired-restart-'))
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: never called for an unbound workspace.
      const client = { restart: vi.fn() } as never
      expect(
        restartPairedOrNotCloud(
          { userDataPath, client },
          { workspaceId: 'row', environmentId: 'env-x' },
          () => undefined
        )
      ).toMatchObject({ ok: false, code: 'not_cloud' })
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
