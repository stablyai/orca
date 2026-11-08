import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { PAIRING_OFFER_VERSION } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY } from '../../shared/automation-runtime-capabilities'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/orcad-runtime-capabilities'
import {
  DORMANT_AUTOMATION,
  dormantState
} from '../persistence/migrating-orcad-catalog/persistence-orcad-migration-catalog-fixture'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted(() => ({ capabilities: ['orcad.migration-catalog.v1'] }))
// Run status preflight, then adapt to the existing single-call assertions.
vi.mock('../../shared/remote-runtime/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    timeoutMs: number,
    validate: (response: unknown) => void,
    envelope: unknown,
    capabilities: unknown,
    signal: unknown
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: { capabilities: status.capabilities }
    })
    return sendRequest(pairing, method, params, timeoutMs, envelope, signal, capabilities)
  }
}))

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

beforeEach(() => {
  vi.clearAllMocks()
  status.capabilities = ['orcad.migration-catalog.v1']
})

describe('remote orcad migration catalog client', () => {
  it.each([stageRemoteOrcadMigrationCatalog, commitRemoteOrcadMigrationCatalog])(
    'requires complete Automation setup support on stage and commit',
    async (request) => {
      const base = manifest()
      const input = { ...base, payload: { ...base.payload, dormantState: dormantState() } }
      await expect(request(pairingCode, input)).rejects.toThrow(
        'keep automation agent launch settings'
      )
      expect(sendRequest).not.toHaveBeenCalled()
      status.capabilities.push(AUTOMATION_LAUNCH_SETUP_RUNTIME_CAPABILITY)
      const result = {
        state: 'staged',
        migrationId: input.migrationId,
        manifestSha256: input.manifestSha256,
        stagedAt: '2026-08-30T12:01:00.000Z'
      }
      sendRequest.mockResolvedValue({ ok: true, result })
      await expect(request(pairingCode, input)).resolves.toEqual(result)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(sendRequest.mock.calls[0]?.[2]).toMatchObject({
        manifest: {
          payload: {
            dormantState: {
              automations: [
                expect.objectContaining({
                  agentArgs: DORMANT_AUTOMATION.agentArgs,
                  launchPreferences: DORMANT_AUTOMATION.launchPreferences
                })
              ]
            }
          }
        }
      })
    }
  )

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

  // #37051: an older host would parse past the history reference and import the automations runless.
  it('never stages or commits a manifest naming its run history on a host without that kind', async () => {
    const base = manifest()
    const withHistory: OrcadMigrationManifest = {
      ...base,
      payload: {
        ...base.payload,
        dormantState: {
          version: 1,
          worktreeMeta: [],
          worktreeLineage: [],
          workspaceLineage: [],
          sparsePresets: [],
          retiredWorktreeNames: [],
          retiredWorktreeNamespaces: [],
          automationRunHistory: { sha256: 'd'.repeat(64), byteLength: 10 }
        }
      }
    }
    const installing = [
      ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
      ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY
    ]
    status.capabilities = installing
    for (const send of [stageRemoteOrcadMigrationCatalog, commitRemoteOrcadMigrationCatalog]) {
      await expect(send(pairingCode, withHistory)).rejects.toThrow(
        /^orcad_migration_destination_blob_kind_unsupported:automation-run-history:/
      )
    }
    expect(sendRequest).not.toHaveBeenCalled()

    status.capabilities = [...installing, 'orcad.migration-blob.automation-run-history.v1']
    sendRequest.mockResolvedValue({
      ok: true,
      result: {
        state: 'staged',
        migrationId: withHistory.migrationId,
        manifestSha256: withHistory.manifestSha256,
        stagedAt: '2026-08-30T12:01:00.000Z'
      }
    })
    await stageRemoteOrcadMigrationCatalog(pairingCode, withHistory)
    expect(sendRequest).toHaveBeenCalledOnce()
  })
})
