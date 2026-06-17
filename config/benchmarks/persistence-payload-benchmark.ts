import { performance } from 'node:perf_hooks'
import type { WorkspaceSessionPatch } from '../../src/shared/types'
import { getDefaultPersistedState } from '../../src/shared/constants'
import {
  buildWorkspaceSessionPayload,
  type WorkspaceSessionSnapshot
} from '../../src/renderer/src/lib/workspace-session'
import { buildWorkspaceSessionPatch } from '../../src/renderer/src/lib/workspace-session-patch'
import { measure, stats, type TimingStats } from './non-terminal-benchmark-stats'
import {
  dirtyDraftBytes,
  makeSyntheticWorkspaceSessionSnapshot,
  type SyntheticPersistenceProfile
} from './persistence-payload-fixture'
import {
  measurePersistenceSubscriberGate,
  type PersistenceSubscriberResult
} from './persistence-subscriber-gate-benchmark'

const PATCH_ITERATIONS = 100
const PAYLOAD_ITERATIONS = 30

export type PersistencePatchResult = {
  scenario: string
  changedFields: string
  patchKeys: string
  patchBytes: number
  stats: TimingStats
}

export type PersistenceStateResult = {
  scenario: string
  repos: number
  worktrees: number
  openFiles: number
  dirtyDraftBytes: number
  workspaceSessionBytes: number
  fullStateBytes: number
  payloadBuildStats: TimingStats
  fullStringifyStats: TimingStats
  largestTopLevelFields: { field: string; bytes: number }[]
}

export type PersistencePayloadBenchmarkResult = {
  patchResults: PersistencePatchResult[]
  stateResults: PersistenceStateResult[]
  subscriberResults: PersistenceSubscriberResult[]
}

function bytesOf(value: unknown, pretty = false): number {
  return Buffer.byteLength(JSON.stringify(value, null, pretty ? 2 : undefined), 'utf8')
}

function measurePatch(
  snapshot: WorkspaceSessionSnapshot,
  scenario: string,
  changedFields: (keyof WorkspaceSessionSnapshot)[]
): PersistencePatchResult {
  let patch: WorkspaceSessionPatch = {}
  const timing = measure(PATCH_ITERATIONS, () => {
    patch = buildWorkspaceSessionPatch(snapshot, changedFields)
  })
  return {
    scenario,
    changedFields: changedFields.join(', '),
    patchKeys: Object.keys(patch).join(', '),
    patchBytes: bytesOf(patch),
    stats: timing
  }
}

function largestTopLevelFields(state: Record<string, unknown>): { field: string; bytes: number }[] {
  return Object.entries(state)
    .map(([field, value]) => ({ field, bytes: bytesOf(value, true) }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 5)
}

function makePersistedState(snapshot: WorkspaceSessionSnapshot): Record<string, unknown> {
  const persisted = getDefaultPersistedState('/Users/bench') as unknown as Record<string, unknown>
  persisted.repos = snapshot.repos
  persisted.worktreeMeta = Object.fromEntries(
    Object.values(snapshot.worktreesByRepo)
      .flat()
      .map((worktree) => [worktree.id, { lastActivityAt: worktree.lastActivityAt }])
  )
  persisted.workspaceSession = buildWorkspaceSessionPayload(snapshot)
  return persisted
}

function measureFullPayload(
  profile: SyntheticPersistenceProfile,
  snapshot: WorkspaceSessionSnapshot
): PersistenceStateResult {
  let workspaceSession = buildWorkspaceSessionPayload(snapshot)
  const payloadBuildStats = measure(PAYLOAD_ITERATIONS, () => {
    workspaceSession = buildWorkspaceSessionPayload(snapshot)
  })
  const persistedState = makePersistedState(snapshot)
  const fullStringifySamples: number[] = []
  for (let index = 0; index < PAYLOAD_ITERATIONS; index += 1) {
    const startedAt = performance.now()
    JSON.stringify(persistedState, null, 2)
    fullStringifySamples.push(performance.now() - startedAt)
  }

  return {
    scenario: 'scaled editor/workspace state; browser maps intentionally empty',
    repos: profile.repoCount,
    worktrees: profile.repoCount * profile.worktreesPerRepo,
    openFiles: snapshot.openFiles.length,
    dirtyDraftBytes: dirtyDraftBytes(snapshot),
    workspaceSessionBytes: bytesOf(workspaceSession, true),
    fullStateBytes: bytesOf(persistedState, true),
    payloadBuildStats,
    fullStringifyStats: stats(fullStringifySamples),
    largestTopLevelFields: largestTopLevelFields(persistedState)
  }
}

export async function runPersistencePayloadBenchmark(): Promise<PersistencePayloadBenchmarkResult> {
  const profile: SyntheticPersistenceProfile = {
    repoCount: 25,
    worktreesPerRepo: 20,
    editorFilesPerWorktree: 2,
    dirtyEvery: 5,
    draftBytes: 512
  }
  const snapshot = makeSyntheticWorkspaceSessionSnapshot(profile)
  return {
    patchResults: [
      measurePatch(snapshot, 'active worktree switch', ['activeWorktreeId']),
      measurePatch(snapshot, 'editor focus change', [
        'activeFileIdByWorktree',
        'activeTabTypeByWorktree'
      ]),
      measurePatch(snapshot, 'dirty editor draft edit', ['editorDrafts']),
      measurePatch(snapshot, 'unified editor tab order/layout change', ['unifiedTabsByWorktree'])
    ],
    stateResults: [measureFullPayload(profile, snapshot)],
    subscriberResults: await measurePersistenceSubscriberGate(snapshot)
  }
}
