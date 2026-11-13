import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../ipc/runtime-environments/runtime-environments', () => ({
  invalidateRuntimeEnvironmentTransport: vi.fn(async () => undefined)
}))
const failQueued = vi.hoisted(() => vi.fn())
vi.mock('./cloud-offline-seam', () => ({ failQueuedCloudPrompts: failQueued }))

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { noteCloudPairingBindings } from '../cloud-workspaces/cloud-paired-environment-ids'
import {
  archivePairedOrNotCloud,
  unarchivePairedOrNotCloud
} from './cloud-workspace-paired-archive'

let userDataPath = ''

beforeEach(() => {
  // No runtime records: every workspace here is a paired one (or not cloud at all).
  userDataPath = mkdtempSync(join(tmpdir(), 'paired-archive-'))
  noteCloudPairingBindings({
    sbx_gh: { environmentId: 'env-gh' },
    sbx_other: { environmentId: 'env-other' }
  })
  failQueued.mockClear()
})

afterEach(() => {
  noteCloudPairingBindings({})
  rmSync(userDataPath, { recursive: true, force: true })
})

const target = { workspaceId: 'row', environmentId: 'env-gh' }

describe('Archive for a paired cloud workspace (PAIRED-ARCHIVE)', () => {
  it('archives its bound sandbox with the PRs, and no checkouts (main never caches them)', async () => {
    const archive = vi.fn(async () => undefined)
    const pullRequests = [{ number: 7, url: 'https://github.com/o/r/pull/7', title: 'x' }]
    const result = await archivePairedOrNotCloud(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `archive` is called, and its answer is ignored.
      { userDataPath, client: { archive } as never },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the PR rows are passed through untouched.
      { ...target, pullRequests: pullRequests as never }
    )
    expect(result).toEqual({ ok: true, value: null })
    expect(archive).toHaveBeenCalledWith('sbx_gh', { pullRequests })
    expect(failQueued).toHaveBeenCalledWith(['row'], expect.any(String))
  })

  it('a server bound to nothing, or no server named, is not cloud: nothing is archived', async () => {
    const archive = vi.fn(async () => undefined)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `archive` would be called.
    const deps = { userDataPath, client: { archive } as never }
    expect(
      await archivePairedOrNotCloud(deps, { workspaceId: 'row', environmentId: 'env-x' })
    ).toMatchObject({
      ok: false,
      code: 'not_cloud'
    })
    expect(await archivePairedOrNotCloud(deps, { workspaceId: 'row' })).toMatchObject({
      ok: false,
      code: 'not_cloud'
    })
    expect(archive).not.toHaveBeenCalled()
  })

  it('a refused archive passes the error back and fails no queued prompt', async () => {
    const result = await archivePairedOrNotCloud(
      {
        userDataPath,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `archive` is called.
        client: {
          archive: async () => {
            throw new Error('not yours')
          }
        } as never
      },
      target
    )
    expect(result.ok).toBe(false)
    expect(failQueued).not.toHaveBeenCalled()
  })
})

describe('Unarchive for a paired cloud workspace (PAIRED-ARCHIVE)', () => {
  it('unarchives its bound sandbox, reconnects only its server, and reports waking', async () => {
    const unarchive = vi.fn(async () => undefined)
    const invalidate = vi.fn(async () => undefined)
    const phases: string[] = []
    const result = await unarchivePairedOrNotCloud(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `unarchive` is called, and its answer is ignored.
      { userDataPath, client: { unarchive } as never, invalidate },
      target,
      (event) => phases.push(event.phase)
    )
    expect(result).toEqual({ ok: true, value: null })
    expect(unarchive).toHaveBeenCalledWith('sbx_gh')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith('env-gh')
    // Settled here: the window's open finds it running and starts no wake that would settle it.
    expect(phases).toEqual(['waking', 'ready'])
  })

  it('a refused unarchive reports failed (the shared wake failure) and passes the error back', async () => {
    const events: { phase: string; source: string }[] = []
    const result = await unarchivePairedOrNotCloud(
      {
        userDataPath,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `unarchive` is called.
        client: {
          unarchive: async () => {
            throw new Error('billing')
          }
        } as never
      },
      target,
      (event) => events.push({ phase: event.phase, source: event.source })
    )
    expect(result.ok).toBe(false)
    expect(events).toEqual([
      { phase: 'waking', source: 'unarchive' },
      { phase: 'failed', source: 'unarchive' }
    ])
  })
})
