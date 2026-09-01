import { describe, expect, it } from 'vitest'
import type { PersistedAgentLaunchFailure } from '../../../shared/agent-launch-contract'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  normalizeWorktreeLinkedItemMetadata,
  normalizeWorktreeMetaAgentLaunchState
} from './worktree-metadata-normalization'

// Only the presence of an entry matters here; the normalizer never reads its linked-item fields.
function makeMeta(): WorktreeMeta {
  return { createdAt: 1 } as WorktreeMeta
}

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return {
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  } as PersistedState
}

describe('normalizeWorktreeLinkedItemMetadata', () => {
  it('reports a null lineage map repair as changed so the load path re-saves it', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() },
      worktreeLineageById: null as unknown as PersistedState['worktreeLineageById']
    })

    // Without this the map stays null on disk and is repaired again on every reload.
    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeLineageById).toEqual({})
  })

  it('reports a null child-key lineage map repair as changed', () => {
    const state = makeState({
      worktreeMeta: {},
      workspaceLineageByChildKey: null as unknown as PersistedState['workspaceLineageByChildKey']
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.workspaceLineageByChildKey).toEqual({})
  })

  it('leaves already-normalized state clean', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(false)
  })
})

describe('normalizeWorktreeMetaAgentLaunchState', () => {
  const validFailure: PersistedAgentLaunchFailure = {
    code: 'spawn_failed',
    version: 1,
    failureId: 'failure-1',
    intent: 'interactive',
    occurredAt: 123
  }
  const validPending = { operationId: 'op-1', requestedAgent: 'claude' as const }

  it('keeps well-formed launch owner fields untouched', () => {
    const meta = {
      ...makeMeta(),
      agentLaunchFailure: validFailure,
      pendingAgentLaunch: validPending
    } as WorktreeMeta
    const state = makeState({ worktreeMeta: { 'r1::/tmp/wt': meta } })

    expect(normalizeWorktreeMetaAgentLaunchState(state)).toBe(false)
    expect(meta.agentLaunchFailure).toEqual(validFailure)
    expect(meta.pendingAgentLaunch).toEqual(validPending)
  })

  it('drops a malformed persisted failure (extra key) so no recovery card forges through', () => {
    const meta = {
      ...makeMeta(),
      agentLaunchFailure: { ...validFailure, argv: ['rm', '-rf'] }
    } as unknown as WorktreeMeta
    const state = makeState({ worktreeMeta: { 'r1::/tmp/wt': meta } })

    expect(normalizeWorktreeMetaAgentLaunchState(state)).toBe(true)
    expect(meta).not.toHaveProperty('agentLaunchFailure')
  })

  it('drops a request-error masquerading as a failure', () => {
    const meta = {
      ...makeMeta(),
      agentLaunchFailure: { code: 'idempotency_conflict' }
    } as unknown as WorktreeMeta
    const state = makeState({ worktreeMeta: { 'r1::/tmp/wt': meta } })

    expect(normalizeWorktreeMetaAgentLaunchState(state)).toBe(true)
    expect(meta).not.toHaveProperty('agentLaunchFailure')
  })

  it('drops a malformed pending launch but keeps a valid sibling field', () => {
    const meta = {
      ...makeMeta(),
      agentLaunchFailure: validFailure,
      pendingAgentLaunch: { operationId: '', requestedAgent: 'claude' }
    } as unknown as WorktreeMeta
    const state = makeState({ worktreeMeta: { 'r1::/tmp/wt': meta } })

    expect(normalizeWorktreeMetaAgentLaunchState(state)).toBe(true)
    expect(meta).not.toHaveProperty('pendingAgentLaunch')
    expect(meta.agentLaunchFailure).toEqual(validFailure)
  })

  it('rejects a pending launch with unknown keys', () => {
    const meta = {
      ...makeMeta(),
      pendingAgentLaunch: { ...validPending, launchCommand: 'evil' }
    } as unknown as WorktreeMeta
    const state = makeState({ worktreeMeta: { 'r1::/tmp/wt': meta } })

    expect(normalizeWorktreeMetaAgentLaunchState(state)).toBe(true)
    expect(meta).not.toHaveProperty('pendingAgentLaunch')
  })
})
