import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

import { collectWorkspaceSessionWorktreeOwners } from './session-worktree-ownership'

function sessionWith(field: keyof WorkspaceSessionState, value: unknown): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), [field]: value } as WorkspaceSessionState
}

describe('workspace session worktree ownership', () => {
  it('prefers an exact candidate id over workspace-key prefix parsing', () => {
    const prefixedId = 'folder::/workspace/target'
    const session = sessionWith('tabsByWorktree', { [prefixedId]: [] })

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([prefixedId]))]).toEqual([
      prefixedId
    ])
  })

  it('matches canonically equivalent Unicode worktree owners', () => {
    const candidateId = 'repo-1::/workspace/Café'.normalize('NFC')
    const ownerId = candidateId.normalize('NFD')
    const session = sessionWith('activeWorktreeId', ownerId)

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]))]).toEqual([
      candidateId
    ])
  })

  it('matches Windows worktree owners across drive case and slash spelling', () => {
    const candidateId = 'repo-1::D:/Agentic/game2'
    const session = sessionWith('activeWorktreeId', 'repo-1::d:\\agentic\\game2')

    expect([...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]))]).toEqual([
      candidateId
    ])
  })

  it('matches macOS /private/tmp session owners to /tmp metadata', () => {
    const candidateId = 'repo-1::/private/tmp/orca/target'
    const session = sessionWith('activeWorktreeId', 'repo-1::/tmp/orca/target')

    expect([
      ...collectWorkspaceSessionWorktreeOwners(session, new Set([candidateId]), 'darwin')
    ]).toEqual([candidateId])
  })

  it('preserves every candidate that shares an owner comparison key', () => {
    const nfcId = 'repo-1::/workspace/Café'.normalize('NFC')
    const nfdId = nfcId.normalize('NFD')
    const session = sessionWith('activeWorktreeId', nfcId)

    expect(
      [...collectWorkspaceSessionWorktreeOwners(session, new Set([nfcId, nfdId]))].sort()
    ).toEqual([nfcId, nfdId].sort())
  })
})
