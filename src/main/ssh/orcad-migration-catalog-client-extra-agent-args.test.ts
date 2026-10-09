import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import { DORMANT_AUTOMATION } from '../persistence-orcad-migration-catalog-fixture'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'

const sendRequest = vi.hoisted(() => vi.fn())
const status = vi.hoisted(() => ({ capabilities: ['orcad.migration-catalog.v1'] }))
// Runs the status preflight, then hands the request to the old single-call shape the cases assert.
vi.mock('../../shared/remote-runtime-client', () => ({
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
  stageRemoteOrcadMigrationCatalog
} = await import('./orcad-migration-catalog-client')

function manifest(extraAgentArgs?: string): OrcadMigrationManifest {
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-08-30T12:00:00.000Z',
    source: {
      sshTargetId: 'ssh-prod',
      sshTargetGeneration: 7,
      targetLabel: 'Production'
    },
    payload: {
      repositories: [],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1 as const,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        automations: [{ ...DORMANT_AUTOMATION, ...(extraAgentArgs ? { extraAgentArgs } : {}) }]
      }
    }
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

describe('orcad migration of automations with extra agent args', () => {
  it.each([stageRemoteOrcadMigrationCatalog, commitRemoteOrcadMigrationCatalog])(
    'refuses a destination without the capability before sending',
    async (request) => {
      await expect(request(pairingCode, manifest('--model opus'))).rejects.toThrow(
        'orcad_migration_destination_extra_agent_args_unsupported'
      )
      expect(sendRequest).not.toHaveBeenCalled()
    }
  )

  it('still reads state and aborts on such a destination', async () => {
    sendRequest.mockResolvedValue({ ok: false, error: { code: 'x', message: 'stop' } })
    for (const request of [
      readRemoteOrcadMigrationCatalogState,
      abortRemoteOrcadMigrationCatalog
    ]) {
      await expect(request(pairingCode, manifest('--model opus'))).rejects.toThrow('stop')
    }
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('sends when the destination advertises the capability or no automation has extras', async () => {
    sendRequest.mockResolvedValue({ ok: false, error: { code: 'x', message: 'sent' } })
    await expect(stageRemoteOrcadMigrationCatalog(pairingCode, manifest())).rejects.toThrow('sent')
    status.capabilities = [...status.capabilities, AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY]
    await expect(
      stageRemoteOrcadMigrationCatalog(pairingCode, manifest('--model opus'))
    ).rejects.toThrow('sent')
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})
