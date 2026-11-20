import { describe, expect, it } from 'vitest'
import {
  captureLegacyRelayBaseline,
  legacyRelayAdoptionBatch
} from './desktop-relay-legacy-adoption'
import type { Repo } from '../../shared/repository/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'

const SSH = getRepoExecutionHostId({ connectionId: 'box' })
const tab = (id: string) => ({ id })

function storeWith(partitions: Map<string, Partial<WorkspaceSessionState>>) {
  const hostIds: ExecutionHostId[] = [SSH, LOCAL_EXECUTION_HOST_ID]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads only id and connectionId.
  const repos = [{ id: 'repo-ssh', connectionId: 'box' }] as Repo[]
  return {
    getRepos: () => repos,
    getWorkspaceSessionHostIds: () => hostIds,
    getWorkspaceSession: (hostId?: string | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tabs and relay ids only.
      (partitions.get(hostId ?? LOCAL_EXECUTION_HOST_ID) ?? {}) as WorkspaceSessionState
  }
}

describe('adopting relay ids saved before ownership was recorded', () => {
  it('adopts SSH repo relays across partitions, including duplicate rows for the same repo', () => {
    const store = storeWith(
      new Map<string, Partial<WorkspaceSessionState>>([
        [
          SSH,
          {
            tabsByWorktree: {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tab ids only.
              'repo-ssh::/w': [
                tab('tab-a'),
                tab('tab-duplicate')
              ] as WorkspaceSessionState['tabsByWorktree'][string],
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tab ids only.
              'folder-1': [tab('tab-folder')] as WorkspaceSessionState['tabsByWorktree'][string]
            },
            remoteSessionIdsByTabId: {
              'tab-a': 'ssh:box@@relay-a',
              'tab-duplicate': 'ssh:box@@relay-duplicate',
              'tab-folder': 'ssh:box@@relay-folder',
              'tab-unknown': 'ssh:box@@relay-unknown'
            }
          }
        ],
        [
          LOCAL_EXECUTION_HOST_ID,
          {
            tabsByWorktree: {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tab ids only.
              'repo-ssh::/w': [
                tab('tab-duplicate')
              ] as WorkspaceSessionState['tabsByWorktree'][string]
            },
            remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' }
          }
        ]
      ])
    )

    const adoptionFor = legacyRelayAdoptionBatch(store, captureLegacyRelayBaseline(store), [
      SSH,
      LOCAL_EXECUTION_HOST_ID
    ])

    expect(adoptionFor(SSH)(store.getWorkspaceSession(SSH))).toEqual({
      'tab-a': 'ssh:box@@relay-a',
      'tab-duplicate': 'ssh:box@@relay-duplicate'
    })
    expect(
      adoptionFor(LOCAL_EXECUTION_HOST_ID)(store.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID))
    ).toEqual({ 'tab-a': 'ssh:box@@relay-a' })
  })

  it("adopts an SSH repo tab's id an older build stored with its row in the local partition", () => {
    const store = storeWith(
      new Map<string, Partial<WorkspaceSessionState>>([
        [
          LOCAL_EXECUTION_HOST_ID,
          {
            tabsByWorktree: {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tab ids only.
              'repo-ssh::/w': [tab('tab-a')] as WorkspaceSessionState['tabsByWorktree'][string]
            },
            remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' }
          }
        ]
      ])
    )
    const adoptionFor = legacyRelayAdoptionBatch(store, captureLegacyRelayBaseline(store), [
      LOCAL_EXECUTION_HOST_ID
    ])

    expect(
      adoptionFor(LOCAL_EXECUTION_HOST_ID)(store.getWorkspaceSession(LOCAL_EXECUTION_HOST_ID))
    ).toEqual({ 'tab-a': 'ssh:box@@relay-a' })
  })

  it('adopts by where rows were at startup, after a first save moved the row out', () => {
    const partitions = new Map<string, Partial<WorkspaceSessionState>>([
      [
        LOCAL_EXECUTION_HOST_ID,
        {
          tabsByWorktree: {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: adoption reads tab ids only.
            'repo-ssh::/w': [tab('tab-a')] as WorkspaceSessionState['tabsByWorktree'][string]
          }
        }
      ],
      [SSH, { tabsByWorktree: {}, remoteSessionIdsByTabId: { 'tab-a': 'ssh:box@@relay-a' } }]
    ])
    const store = storeWith(partitions)
    const baseline = captureLegacyRelayBaseline(store)
    // The window's first save writes local first, routing the row to its SSH partition.
    partitions.set(LOCAL_EXECUTION_HOST_ID, { tabsByWorktree: {} })

    expect(
      legacyRelayAdoptionBatch(store, baseline, [SSH])(SSH)(store.getWorkspaceSession(SSH))
    ).toEqual({
      'tab-a': 'ssh:box@@relay-a'
    })
  })
})
