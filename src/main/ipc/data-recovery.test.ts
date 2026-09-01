import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  app: { quit: vi.fn() },
  ipcMain: { handle: handleMock }
}))

vi.mock('../data-recovery/recovery-points', () => ({
  listRecoveryPoints: vi.fn(() => []),
  restoreRecoveryPoint: vi.fn(async () => ({ ok: true }))
}))

import { registerDataRecoveryHandlers } from './data-recovery'
import type { DataRecoveryMigrationStatus } from '../../shared/data-recovery'

function migrationStatusFor(store: {
  getAgentCatalogMigrationError(): string | null
  getAgentCatalogSchemaTooNew(): { persistedVersion: number; supportedVersion: number } | null
}): DataRecoveryMigrationStatus {
  registerDataRecoveryHandlers({ ...store, getDataFilePath: () => '/tmp/orca.json' } as never)
  const handler = handleMock.mock.calls.find(
    (call) => call[0] === 'dataRecovery:migrationStatus'
  )?.[1] as () => DataRecoveryMigrationStatus
  return handler()
}

describe('dataRecovery:migrationStatus', () => {
  beforeEach(() => {
    handleMock.mockClear()
  })

  it('reports a read-only profile stamped by a newer build', () => {
    expect(
      migrationStatusFor({
        getAgentCatalogMigrationError: () => null,
        getAgentCatalogSchemaTooNew: () => ({ persistedVersion: 2, supportedVersion: 1 })
      })
    ).toEqual({
      agentCatalogMigrationError: null,
      agentCatalogSchemaTooNew: { persistedVersion: 2, supportedVersion: 1 }
    })
  })

  it('reports null for a healthy profile so the renderer shows no notice', () => {
    expect(
      migrationStatusFor({
        getAgentCatalogMigrationError: () => null,
        getAgentCatalogSchemaTooNew: () => null
      })
    ).toEqual({ agentCatalogMigrationError: null, agentCatalogSchemaTooNew: null })
  })
})
