import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listWslDriveUncConversions,
  writeWslDriveUncConversion,
  type WslDriveUncConversion
} from './wsl-drive-unc-conversion-journal'
import {
  listPendingWslDriveUncRendererRewrites,
  recordWslDriveUncRendererStoreRewritten
} from './wsl-drive-unc-conversion-renderer'

const MAIN = ['terminal-history', 'shell-history']
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-drive-unc-renderer-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function journal(overrides: Partial<WslDriveUncConversion> = {}): void {
  writeWslDriveUncConversion(root, {
    version: 1,
    migrationId: 'conv-1',
    distro: 'Ubuntu',
    profileId: 'profile-1',
    repoIds: ['r1'],
    folderWorkspaceIds: [],
    rootPaths: ['\\\\wsl.localhost\\Ubuntu\\mnt\\c\\src\\app'],
    phase: 'profile-rewritten',
    worktreeIds: [['r1::old', 'r1::new']],
    rewrittenStores: [...MAIN],
    createdAt: '2026-10-24T00:00:00.000Z',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...overrides
  })
}

const record = (storeId: string) =>
  recordWslDriveUncRendererStoreRewritten(root, { migrationId: 'conv-1', storeId }, MAIN)

describe('the window half of a Windows-drive conversion', () => {
  it('lists a converted profile with the stores still to record', () => {
    journal()
    expect(listPendingWslDriveUncRendererRewrites(root)).toEqual([
      expect.objectContaining({
        migrationId: 'conv-1',
        worktreeIds: [['r1::old', 'r1::new']],
        storeIds: ['quick-open-history', 'file-view-preferences', 'notebook-environments']
      })
    ])
  })

  it('lists nothing before the profile rewrite', () => {
    journal({ phase: 'prepared', rewrittenStores: [] })
    expect(listPendingWslDriveUncRendererRewrites(root)).toEqual([])
    expect(record('quick-open-history')).toEqual({ recorded: false, reason: 'not-pending' })
  })

  it('drops the journal once every store is recorded', () => {
    journal()
    expect(record('quick-open-history')).toEqual({ recorded: true })
    expect(record('quick-open-history')).toEqual({ recorded: false, reason: 'not-pending' })
    expect(record('bogus')).toEqual({ recorded: false, reason: 'unknown-store' })
    expect(record('file-view-preferences')).toEqual({ recorded: true })
    expect(listWslDriveUncConversions(root)).toHaveLength(1)
    expect(record('notebook-environments')).toEqual({ recorded: true })
    expect(listWslDriveUncConversions(root)).toEqual([])
  })

  it('keeps the journal while a main store still retries', () => {
    journal({ rewrittenStores: ['terminal-history'] })
    for (const id of ['quick-open-history', 'file-view-preferences', 'notebook-environments']) {
      record(id)
    }
    expect(listWslDriveUncConversions(root)).toHaveLength(1)
  })
})
