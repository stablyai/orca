import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: sendRequest }))

const {
  abortRemoteOrcadMigrationCatalog,
  commitRemoteOrcadMigrationCatalog,
  readRemoteOrcadMigrationCatalogState,
  stageRemoteOrcadMigrationCatalog,
  stageRemoteOrcadMigrationSnapshotChunk
} = await import('./orcad-migration-catalog-client')

function manifest(): OrcadMigrationManifest {
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-08-30T12:00:00.000Z',
    source: {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 7,
      targetLabel: 'Production'
    },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
  }
  return { ...unsigned, manifestSha256: computeOrcadMigrationManifestSha256(unsigned) }
}

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

beforeEach(() => vi.clearAllMocks())

describe('remote orcad migration catalog client', () => {
  it.each([
    stageRemoteOrcadMigrationCatalog,
    commitRemoteOrcadMigrationCatalog,
    readRemoteOrcadMigrationCatalogState,
    abortRemoteOrcadMigrationCatalog
  ])(
    'refuses another runtime or missing authenticated runtime metadata when pinned',
    async (request) => {
      for (const runtimeId of ['other-runtime', undefined]) {
        sendRequest.mockResolvedValue({ ok: true, _meta: { runtimeId }, result: {} })
        await expect(
          request(pairingCode, manifest(), { expectedRuntimeId: 'runtime' })
        ).rejects.toThrow('destination_runtime_mismatch')
      }
    }
  )

  it('pins snapshot acknowledgments to the admitted destination runtime', async () => {
    const request = {
      migrationId: 'migration-1',
      manifestSha256: manifest().manifestSha256,
      ref: `v1-${'1'.repeat(32)}`,
      offset: 0,
      bytesBase64: 'YQ=='
    }
    sendRequest.mockResolvedValue({
      ok: true,
      _meta: { runtimeId: 'other' },
      result: { ...request, acknowledgedOffset: 1 }
    })
    await expect(
      stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request, { expectedRuntimeId: 'runtime' })
    ).rejects.toThrow('destination_runtime_mismatch')
    sendRequest.mockResolvedValue({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { ...request, acknowledgedOffset: 1 }
    })
    await expect(
      stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request, { expectedRuntimeId: 'runtime' })
    ).resolves.toMatchObject({ acknowledgedOffset: 1 })
  })

  it.each([
    ['stage', 'orcad.migration.stageCatalog', stageRemoteOrcadMigrationCatalog],
    ['commit', 'orcad.migration.commitCatalog', commitRemoteOrcadMigrationCatalog],
    ['state', 'orcad.migration.catalogState', readRemoteOrcadMigrationCatalogState]
  ] as const)('sends and validates the %s operation', async (_label, method, request) => {
    const input = manifest()
    const result = {
      state: 'staged',
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      stagedAt: '2026-08-30T12:01:00.000Z'
    }
    sendRequest.mockResolvedValue({ ok: true, result })
    const signal = new AbortController().signal

    await expect(request(pairingCode, input, { signal, timeoutMs: 1234 })).resolves.toEqual(result)
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:46768/runtime' }),
      method,
      { manifest: input },
      1234,
      undefined,
      signal,
      expect.any(Object)
    )
  })

  it('validates an abort result without letting it erase committed state', async () => {
    const input = manifest()
    sendRequest.mockResolvedValue({
      ok: true,
      result: {
        state: 'absent',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256,
        aborted: true
      }
    })

    await expect(abortRemoteOrcadMigrationCatalog(pairingCode, input)).resolves.toMatchObject({
      state: 'absent',
      aborted: true
    })
  })

  it.each([undefined, true, false, 'true'])(
    'requires explicit persistence evidence for an already-absent abort (%s)',
    async (durableAbsent) => {
      const input = manifest()
      sendRequest.mockResolvedValue({
        ok: true,
        result: {
          state: 'absent',
          migrationId: input.migrationId,
          manifestSha256: input.manifestSha256,
          aborted: false,
          ...(durableAbsent === undefined ? {} : { durableAbsent })
        }
      })
      const result = abortRemoteOrcadMigrationCatalog(pairingCode, input)
      if (durableAbsent === true) {
        await expect(result).resolves.toMatchObject({ durableAbsent: true, aborted: false })
        return
      }
      await expect(result).rejects.toThrow(/durability/)
    }
  )

  it('validates a committed receipt against the requested manifest', async () => {
    const input = manifest()
    const receipt = {
      version: ORCAD_MIGRATION_MANIFEST_VERSION,
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      source: input.source,
      importedAt: '2026-08-30T12:02:00.000Z',
      repositoryIds: [],
      projectGroupIds: [],
      folderWorkspaceIds: []
    }
    sendRequest.mockResolvedValue({
      ok: true,
      result: {
        state: 'committed',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256,
        receipt
      }
    })

    await expect(commitRemoteOrcadMigrationCatalog(pairingCode, input)).resolves.toMatchObject({
      state: 'committed',
      receipt
    })
  })

  it('uploads a snapshot chunk and requires the exact acknowledgment', async () => {
    const input = manifest()
    const request = {
      migrationId: input.migrationId,
      manifestSha256: input.manifestSha256,
      ref: `v1-${'1'.repeat(32)}`,
      offset: 4,
      bytesBase64: 'YQ=='
    }
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...request, acknowledgedOffset: 5 }
    })
    await expect(
      stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request)
    ).resolves.toMatchObject({ acknowledgedOffset: 5 })
    expect(sendRequest).toHaveBeenLastCalledWith(
      expect.any(Object),
      'orcad.migration.stageSnapshotChunk',
      request,
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...request, acknowledgedOffset: 4 }
    })
    await expect(stageRemoteOrcadMigrationSnapshotChunk(pairingCode, request)).rejects.toThrow(
      'orcad_migration_snapshot_chunk_result_invalid'
    )
  })

  it('fails closed when a staged old host omits required snapshot upload state', async () => {
    const input = manifest()
    input.payload.dormantState = {
      version: 1,
      worktreeMeta: [],
      worktreeLineage: [],
      workspaceLineage: [],
      sparsePresets: [],
      retiredWorktreeNames: [],
      retiredWorktreeNamespaces: [],
      terminalScrollbackSnapshots: [
        {
          tabId: 'tab-1',
          leafId: 'leaf-1',
          ref: `v1-${'1'.repeat(32)}`,
          sha256: 'b'.repeat(64),
          byteLength: 1
        }
      ]
    }
    sendRequest.mockResolvedValue({
      ok: true,
      result: {
        state: 'staged',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256,
        stagedAt: '2026-08-30T12:01:00.000Z'
      }
    })

    await expect(readRemoteOrcadMigrationCatalogState(pairingCode, input)).rejects.toThrow(
      'orcad_migration_snapshot_transfer_unsupported'
    )
  })

  it('rejects malformed stage timestamps and abort envelopes', async () => {
    const input = manifest()
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        state: 'staged',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256,
        stagedAt: 'not-a-date'
      }
    })
    await expect(stageRemoteOrcadMigrationCatalog(pairingCode, input)).rejects.toThrow(
      'orcad_migration_catalog_state_staged_at_invalid'
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: {
        state: 'absent',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256
      }
    })
    await expect(abortRemoteOrcadMigrationCatalog(pairingCode, input)).rejects.toThrow(
      'orcad_migration_catalog_abort_result_invalid'
    )
  })

  it('fails closed for method absence, malformed identity, and invalid pairing', async () => {
    const input = manifest()
    sendRequest.mockResolvedValueOnce({ ok: false, error: { message: 'method not found' } })
    await expect(stageRemoteOrcadMigrationCatalog(pairingCode, input)).rejects.toThrow(
      'orcad_migration_stage_failed:method not found'
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { state: 'absent', migrationId: 'other', manifestSha256: input.manifestSha256 }
    })
    await expect(readRemoteOrcadMigrationCatalogState(pairingCode, input)).rejects.toThrow(
      'orcad_migration_catalog_state_identity_mismatch'
    )

    await expect(stageRemoteOrcadMigrationCatalog('invalid', input)).rejects.toThrow(
      'orcad_migration_pairing_code_invalid'
    )
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
