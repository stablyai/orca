import { afterEach, expect, vi } from 'vitest'
import type { controlReleaseFixture } from '../persistence-orcad-live-retirement-installation.test'
import { testState } from '../persistence-test-harness'
import { resumeOrcadLiveMigration } from './orcad-live-migration-resume'
import { liveCleanupRuntimeFixture } from './orcad-live-runtime-test-fixture'
import { OrcadLiveRuntimeCleanupCheckpointStore } from './orcad-live-runtime-cleanup-checkpoint'
import { OrcadLiveCleanupOutputEvidenceStore } from './orcad-live-cleanup-output-evidence'
import { seedLiveRetirementCaptures } from './orcad-live-retirement-capture-test-fixture'
import * as remoteRetirement from './orcad-captured-source-retirement-client'
import { parsePtyOwnershipTransferSourceRetirementEvidence } from '../../shared/pty-ownership-transfer-source-retirement'
import { sshProviders, sshProvidersByGeneration } from '../ipc/pty/provider/registry'
import { ptyOwnership, ptyIncarnationById } from '../ipc/pty/provider/ownership-state'

const routeCleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of routeCleanups.splice(0)) {
    cleanup()
  }
})

export async function liveRuntimeLifecycleFixture(
  fixture: typeof controlReleaseFixture,
  kind: 'folder' | 'worktree',
  installProfile = true
) {
  const f = await fixture(kind, installProfile)
  const actual = await liveCleanupRuntimeFixture(f.cutover)
  sshProviders.set(f.target.id, f.provider)
  sshProvidersByGeneration.set(f.provider.providerGeneration, f.provider)
  for (const [index, entry] of actual.entries.entries()) {
    ptyOwnership.set(entry.ptyId, f.target.id)
    ptyIncarnationById.set(
      entry.ptyId,
      f.cutover.liveTerminalBindings![index].identity.incarnationId
    )
  }
  routeCleanups.push(() => {
    if (sshProviders.get(f.target.id) === f.provider) {
      sshProviders.delete(f.target.id)
    }
    for (const [generation, provider] of sshProvidersByGeneration) {
      if (provider === f.provider) {
        sshProvidersByGeneration.delete(generation)
      }
    }
    for (const entry of actual.entries) {
      ptyOwnership.delete(entry.ptyId)
      ptyIncarnationById.delete(entry.ptyId)
    }
  })
  const activate = f.activate.getMockImplementation()!
  f.activate.mockImplementation(async (...args) => {
    const output = new OrcadLiveCleanupOutputEvidenceStore(testState.dir).read(f.record.identity)
    if (output) {
      // Seed capture transport fixtures only after production cleanup has persisted settlement.
      seedLiveRetirementCaptures(testState.dir, {
        ...f,
        released: {
          sourceOutputSettlements: output.settlements
        }
      })
    }
    return activate(...args)
  })
  vi.spyOn(remoteRetirement, 'retireRemoteOrcadCapturedSourceDelivery').mockImplementation(
    async ({ request, assertAuthority }) => {
      assertAuthority()
      expect(f.store.inspectOrcadLiveRetirementProfileState(f.record).state).toBe(
        'profile-installed'
      )
      expect(
        new OrcadLiveRuntimeCleanupCheckpointStore(testState.dir).read(f.record.identity)
      ).toBeTruthy()
      return parsePtyOwnershipTransferSourceRetirementEvidence({
        ...(request.identity as object),
        version: 1,
        sourceDeliveryRetirement: {
          phase: 'retired',
          retirementRecordSha256: request.retirementRecordSha256,
          delivery: request.expectedDelivery
        }
      })
    }
  )
  f.mux.request.mockImplementation(async (...args: unknown[]) => {
    expect(args[0]).toBe('pty.cancelDelivery')
    return { canceled: true, sentEndSu: 4, creditedEndSu: 4 }
  })
  const run = (signal = new AbortController().signal, recoveryOnly = false, store = f.store) =>
    resumeOrcadLiveMigration({
      profileDirectory: testState.dir,
      store,
      migrationId: f.cutover.manifest.migrationId,
      runtime: actual.runtime,
      remote: {
        ...f.remote,
        stage: vi.fn(async () => {
          throw new Error('installed profile must not restage')
        }),
        snapshot: vi.fn(async () => {
          throw new Error('installed profile must not restage snapshots')
        })
      },
      activate: f.activate,
      signal,
      recoveryOnly
    })
  return { ...f, ...actual, run }
}
