import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { liveSourceCompletionEvidenceFixture } from './orcad-live-source-completion-evidence-test-fixture'
import { liveSourceRetirementFixture } from '../persistence/migrating-orcad-catalog/orcad-live-source-retirement-test-fixture'
import { readOrcadLiveSourceCompletionEvidence } from './orcad-live-source-completion-evidence'
import { createOrcadLiveCompletedCutover } from './orcad-live-completed-cutover'
import { OrcadRetirementSessionPublication } from '../persistence/loading-store/orcad-retirement-session-publication'
import { OrcadLiveCompletionDurability } from '../persistence/loading-store/orcad-live-completion-durability'
import { requireOrcadRetirementRendererEvidence } from '../persistence/loading-store/orcad-retirement-renderer-evidence'
import { getOrcadLiveMigrationRendererPlan } from './orcad-live-migration-renderer-plan'
import { OrcadLiveSourceRouteCheckpointStore } from './orcad-live-source-route-checkpoint'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('../../shared/runtime-environment-store', () => ({ resolveEnvironment: resolve }))
let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-renderer-plan-evidence-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})
function fixture(kind: 'folder' | 'worktree') {
  const f = liveSourceCompletionEvidenceFixture(root, kind)
  f.persist()
  const completionEvidence = readOrcadLiveSourceCompletionEvidence(root, f.committed)
  const completed = createOrcadLiveCompletedCutover({
    committed: f.committed,
    completionEvidence,
    retiredAt: '2026-09-08T12:00:00.000Z'
  })
  const state = liveSourceRetirementFixture(kind).run()
  state.orcadMigrationSourceCutovers = [completed]
  state.orcadLiveRetirementMarkers = [
    {
      version: 1,
      migrationId: completed.manifest.migrationId,
      recordSha256: f.record.sha256,
      installedAt: '2026-09-08T12:00:00.000Z'
    }
  ]
  const storeDirectory = join(root, 'store-profile')
  const publication = new OrcadRetirementSessionPublication(storeDirectory)
  publication.record(f.record)
  const runtime = {
    state,
    orcadRetirementSessionPublication: publication,
    orcadLiveCompletionDurability: new OrcadLiveCompletionDurability()
  }
  runtime.orcadLiveCompletionDurability.acknowledge(
    OrcadLiveCompletionDurability.capture([completed])
  )
  const store = {
    getProfileStorageDirectory: () => storeDirectory,
    getOrcadLiveMigrationRendererEvidence: (id: string) =>
      requireOrcadRetirementRendererEvidence(runtime, id)
  }
  resolve.mockReturnValue({
    id: completed.destinationEnvironmentId,
    runtimeId: completed.liveTerminalBindings![0].identity.destinationRuntimeId
  })
  const run = () =>
    getOrcadLiveMigrationRendererPlan(root, store, {
      selector: 'environment',
      migrationId: completed.manifest.migrationId
    })
  return { ...f, runtime, state, completed, run }
}

it.each(['folder', 'worktree'] as const)(
  'reads a %s plan through real retained evidence after unrelated edits',
  (kind) => {
    const f = fixture(kind)
    f.state.repos.push({
      id: 'unrelated',
      path: '/unrelated',
      displayName: 'Unrelated',
      badgeColor: '',
      addedAt: 1
    })
    const plan = f.run()
    expect(plan.migrationId).toBe(f.completed.manifest.migrationId)
    expect(plan.retirementRecordSha256).toBe(f.record.sha256)
    expect(plan.workspaces.flatMap(({ terminals }) => terminals)).toHaveLength(
      f.completed.liveTerminalBindings!.length
    )
    const before = structuredClone(f.state)
    f.run()
    expect(f.state).toEqual(before)
  }
)

it.each(['marker', 'hash', 'fence', 'durability', 'journal', 'checkpoint'] as const)(
  'refuses %s evidence loss without returning a plan',
  (kind) => {
    const f = fixture('folder')
    if (kind === 'marker') {
      f.state.orcadLiveRetirementMarkers = []
    }
    if (kind === 'hash') {
      f.state.orcadLiveRetirementMarkers![0].recordSha256 = 'f'.repeat(64)
    }
    if (kind === 'fence') {
      f.state.sshTargets = []
    }
    if (kind === 'durability') {
      f.runtime.orcadLiveCompletionDurability.invalidate()
    }
    if (kind === 'journal') {
      f.state.orcadMigrationSourceCutovers = [f.committed]
    }
    if (kind === 'checkpoint') {
      vi.spyOn(OrcadLiveSourceRouteCheckpointStore.prototype, 'list').mockReturnValue([])
    }
    expect(f.run).toThrow()
  }
)
