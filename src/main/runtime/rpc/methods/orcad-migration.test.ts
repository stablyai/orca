import { describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../../shared/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../../../orcad/orcad-migration-manifest-digest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'
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
  'orcad.migration.abortCatalog',
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
  it('registers every staged-cutover method exactly once', () => {
    for (const name of MIGRATION_METHOD_NAMES) {
      expect(ALL_RPC_METHODS.filter((method) => method.name === name)).toHaveLength(1)
    }
  })

  it('stages, commits, aborts, and reconciles through the authenticated runtime client', async () => {
    const input = manifest()
    const signal = new AbortController().signal
    const stage = vi.fn().mockResolvedValue({ state: 'staged' })
    const commit = vi.fn().mockResolvedValue({ state: 'committed' })
    const snapshot = vi.fn().mockReturnValue({ acknowledgedOffset: 1 })
    const abort = vi.fn().mockResolvedValue({ state: 'absent', aborted: true })
    const state = vi.fn().mockReturnValue({ state: 'staged' })
    const runtime = {
      stageOrcadMigrationCatalog: stage,
      commitStagedOrcadMigrationCatalog: commit,
      stageOrcadMigrationSnapshotChunk: snapshot,
      abortStagedOrcadMigrationCatalog: abort,
      getOrcadMigrationCatalogState: state
    }
    const caller = context(vi.fn(), { signal }, runtime)

    await expect(
      migrationMethod('orcad.migration.stageCatalog').handler({ manifest: input }, caller)
    ).resolves.toEqual({ state: 'staged' })
    await expect(
      migrationMethod('orcad.migration.commitCatalog').handler({ manifest: input }, caller)
    ).resolves.toEqual({ state: 'committed' })
    const snapshotRequest = migrationSnapshotRequest(input)
    await expect(
      migrationMethod('orcad.migration.stageSnapshotChunk').handler(snapshotRequest, caller)
    ).resolves.toEqual({ acknowledgedOffset: 1 })
    await expect(
      migrationMethod('orcad.migration.abortCatalog').handler({ manifest: input }, caller)
    ).resolves.toEqual({ state: 'absent', aborted: true })
    await expect(
      migrationMethod('orcad.migration.catalogState').handler({ manifest: input }, caller)
    ).resolves.toEqual({ state: 'staged' })
    expect(stage).toHaveBeenCalledWith(input, { signal })
    expect(commit).toHaveBeenCalledWith(input, { signal })
    expect(snapshot).toHaveBeenCalledWith(snapshotRequest)
    expect(abort).toHaveBeenCalledWith(input, { signal })
    expect(state).toHaveBeenCalledWith(input)
  })

  it.each([
    ['mobile client', { clientKind: 'mobile', pairedDeviceId: 'paired-phone' }],
    ['unpaired runtime client', { clientKind: 'runtime', pairedDeviceId: undefined }],
    ['local caller', { clientKind: undefined, pairedDeviceId: undefined }]
  ] as const)('rejects a %s before any migration mutation', async (_label, caller) => {
    for (const name of MIGRATION_METHOD_NAMES) {
      const invoke = vi.fn()
      const method = migrationMethod(name)
      const runtimeMethod =
        name === 'orcad.migration.stageCatalog'
          ? 'stageOrcadMigrationCatalog'
          : name === 'orcad.migration.commitCatalog'
            ? 'commitStagedOrcadMigrationCatalog'
            : name === 'orcad.migration.stageSnapshotChunk'
              ? 'stageOrcadMigrationSnapshotChunk'
              : name === 'orcad.migration.abortCatalog'
                ? 'abortStagedOrcadMigrationCatalog'
                : 'getOrcadMigrationCatalogState'

      await expect(
        method.handler(
          method.params?.parse(migrationMethodInput(name)),
          context(invoke, caller, { [runtimeMethod]: invoke })
        )
      ).rejects.toThrow('orcad_migration_runtime_client_required')
      expect(invoke).not.toHaveBeenCalled()
    }
  })

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

function migrationSnapshotRequest(input: OrcadMigrationManifest) {
  return {
    migrationId: input.migrationId,
    manifestSha256: input.manifestSha256,
    ref: `v1-${'1'.repeat(32)}`,
    offset: 0,
    bytesBase64: 'YQ=='
  }
}

function migrationMethodInput(name: (typeof MIGRATION_METHOD_NAMES)[number]) {
  const input = manifest()
  return name === 'orcad.migration.stageSnapshotChunk'
    ? migrationSnapshotRequest(input)
    : { manifest: input }
}
