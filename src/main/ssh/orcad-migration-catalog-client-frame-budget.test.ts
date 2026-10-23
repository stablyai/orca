import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadMigrationBlobDescriptor } from '../../shared/orcad-migration/orcad-migration-blob-transfer'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration/orcad-migration-manifest'
import {
  MAX_ORCAD_MIGRATION_MANIFEST_BYTES,
  ORCAD_MIGRATION_MANIFEST_VERSION
} from '../../shared/orcad-migration/orcad-migration-manifest-validation'
import {
  ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY,
  ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY
} from '../../shared/orcad-runtime-capabilities'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

const sendRequest = vi.hoisted(() => vi.fn())
const extraCapabilities = vi.hoisted((): string[] => [])
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: async (
    pairing: unknown,
    method: string,
    params: unknown,
    _timeoutMs: number,
    validate: (response: unknown) => void
  ) => {
    validate({
      ok: true,
      _meta: { runtimeId: 'runtime' },
      result: {
        capabilities: [
          ORCAD_MIGRATION_CATALOG_RUNTIME_CAPABILITY,
          ORCAD_MIGRATION_BLOB_CHANNEL_RUNTIME_CAPABILITY,
          'orcad.migration-blob.agent-session-records.v1',
          ...extraCapabilities
        ]
      }
    })
    return sendRequest(pairing, method, params)
  }
}))

const { commitRemoteOrcadMigrationCatalog, stageRemoteOrcadMigrationCatalog } =
  await import('./orcad-migration-catalog-client')
const {
  abortRemoteOrcadMigrationCatalogByReference,
  ORCAD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED
} = await import('./orcad-migration-catalog-reference-client')

const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'paired-desktop'
})

/** A manifest whose JSON is exactly `bytes` long. */
function manifestOfBytes(bytes: number): OrcadMigrationManifest {
  const withLabel = (targetLabel: string): OrcadMigrationManifest => ({
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-frame',
    createdAt: '2026-10-18T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel },
    payload: { repositories: [], projectGroups: [], folderWorkspaces: [] },
    manifestSha256: 'a'.repeat(64)
  })
  return withLabel('x'.repeat(bytes - JSON.stringify(withLabel('')).length))
}

const manyBlobs: OrcadMigrationBlobDescriptor[] = Array.from({ length: 200 }, (_, index) => ({
  blobKind: 'agent-session-records',
  key: `session-${index}-${'s'.repeat(64)}`,
  sha256: 'c'.repeat(64),
  byteLength: 1024
}))

beforeEach(() => {
  vi.clearAllMocks()
  extraCapabilities.length = 0
  sendRequest.mockResolvedValue({
    ok: true,
    _meta: { runtimeId: 'runtime' },
    result: {
      state: 'staged',
      migrationId: 'migration-frame',
      manifestSha256: 'a'.repeat(64),
      stagedAt: '2026-10-18T12:00:00.000Z'
    }
  })
})

describe("orcad migration requests fit the host's sealed inbound frame", () => {
  it('stages a large manifest that still fits', async () => {
    await stageRemoteOrcadMigrationCatalog(pairingCode, manifestOfBytes(760 * 1024))
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses, unsent, a manifest at the validation cap: sealed, it overflows the 1 MiB frame', async () => {
    await expect(
      stageRemoteOrcadMigrationCatalog(
        pairingCode,
        manifestOfBytes(MAX_ORCAD_MIGRATION_MANIFEST_BYTES)
      )
    ).rejects.toThrow(/\(orcad_migration_manifest_too_large\)$/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('refuses, unsent, a commit whose blob list pushes a fitting manifest past the frame', async () => {
    const manifest = manifestOfBytes(760 * 1024)
    await expect(
      commitRemoteOrcadMigrationCatalog(pairingCode, manifest, { expectedBlobs: manyBlobs })
    ).rejects.toThrow(/too large to move to its Orca server/)
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('aborts a manifest no request can carry by its identity alone, durably', async () => {
    extraCapabilities.push(ORCAD_MIGRATION_CATALOG_ABORT_BY_REFERENCE_RUNTIME_CAPABILITY)
    const manifest = manifestOfBytes(MAX_ORCAD_MIGRATION_MANIFEST_BYTES)
    const identity = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true, durableAbsent: true }
    })
    await expect(
      abortRemoteOrcadMigrationCatalogByReference(pairingCode, manifest)
    ).resolves.toEqual({ ...identity, state: 'absent', aborted: true, durableAbsent: true })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.anything(),
      'orcad.migration.abortCatalogByReference',
      identity
    )

    sendRequest.mockResolvedValueOnce({
      ok: true,
      result: { ...identity, state: 'absent', aborted: true }
    })
    await expect(
      abortRemoteOrcadMigrationCatalogByReference(pairingCode, manifest)
    ).rejects.toThrow('orcad_migration_catalog_abort_durability_invalid')
  })

  it('refuses, unsent, an abort by reference to a host that predates it', async () => {
    await expect(
      abortRemoteOrcadMigrationCatalogByReference(
        pairingCode,
        manifestOfBytes(MAX_ORCAD_MIGRATION_MANIFEST_BYTES)
      )
    ).rejects.toThrow(ORCAD_MIGRATION_DESTINATION_ABORT_BY_REFERENCE_UNSUPPORTED)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
