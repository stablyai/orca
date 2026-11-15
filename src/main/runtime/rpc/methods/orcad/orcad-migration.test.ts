import { describe, expect, it, vi } from 'vitest'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../../../../shared/orcad-migration/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../../../../orcad/migration/orcad-migration-manifest-digest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import '../rpc-method-registry'
import { ORCAD_MIGRATION_METHODS } from './orcad-migration'

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
  return {
    ...unsigned,
    manifestSha256: computeOrcadMigrationManifestSha256(unsigned)
  }
}

const MIGRATION_METHOD_NAMES = [
  'orcad.migration.stageCatalog',
  'orcad.migration.commitCatalog',
  'orcad.migration.stageSnapshotChunk',
  'orcad.migration.stageBlobChunk',
  'orcad.migration.abortCatalog',
  'orcad.migration.abortCatalogByReference',
  'orcad.migration.catalogState'
] as const

function migrationMethod(
  name: (typeof MIGRATION_METHOD_NAMES)[number] = MIGRATION_METHOD_NAMES[0]
) {
  const method = eraseRpcMethods(ORCAD_MIGRATION_METHODS).find(
    (candidate) => candidate.name === name
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing or invalid ${name} method`)
  }
  return method
}

function context(
  stageOrcadMigrationCatalog: ReturnType<typeof vi.fn>,
  overrides: Partial<RpcContext> = {},
  runtimeOverrides: Record<string, unknown> = {}
): RpcContext {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the migration methods call only the runtime members stubbed here.
    runtime: { stageOrcadMigrationCatalog, ...runtimeOverrides } as unknown as OrcaRuntimeService,
    clientKind: 'runtime',
    pairedDeviceId: 'paired-desktop',
    ...overrides
  }
}

describe('orcad migration RPC', () => {
  it('rejects malformed and tampered manifests before staging', async () => {
    const stageCatalog = vi.fn()
    const method = migrationMethod()
    const input = manifest()

    await expect(
      method.handler(
        method.params?.parse({ manifest: { ...input, manifestSha256: 'invalid' } }),
        context(stageCatalog)
      )
    ).rejects.toThrow('orcad_migration_manifest_digest_invalid')
    await expect(
      method.handler(
        method.params?.parse({
          manifest: { ...input, source: { ...input.source, targetLabel: 'Tampered' } }
        }),
        context(stageCatalog)
      )
    ).rejects.toThrow('orcad_migration_manifest_digest_mismatch')
    expect(stageCatalog).not.toHaveBeenCalled()
  })

  it('verifies a newer client signature over fields this host does not know', async () => {
    const stageCatalog = vi.fn()
    const method = migrationMethod()
    const { manifestSha256: _, ...known } = manifest()
    const unsigned = {
      ...known,
      futureField: { enabled: true },
      source: { ...known.source, futureSourceField: 'x' }
    }
    const signed = {
      ...unsigned,
      manifestSha256: computeOrcadMigrationManifestSha256(unsigned)
    }

    await method.handler(method.params?.parse({ manifest: signed }), context(stageCatalog))
    expect(stageCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ manifestSha256: signed.manifestSha256, source: known.source }),
      expect.anything()
    )
    await expect(
      method.handler(
        method.params?.parse({ manifest: { ...signed, futureField: { enabled: false } } }),
        context(stageCatalog)
      )
    ).rejects.toThrow('orcad_migration_manifest_digest_mismatch')
    const { futureField: __, ...stripped } = signed
    await expect(
      method.handler(method.params?.parse({ manifest: stripped }), context(stageCatalog)),
      'a peer that drops a signed field'
    ).rejects.toThrow('orcad_migration_manifest_digest_mismatch')
    expect(stageCatalog).toHaveBeenCalledTimes(1)
  })
})
