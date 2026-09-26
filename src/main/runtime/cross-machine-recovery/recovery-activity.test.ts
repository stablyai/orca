import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoveryLayout } from '../../../shared/cross-machine-recovery-descriptor'
import {
  RECOVERY_PRESENTATION_RETENTION_MS,
  type RecoveryPresentationWorkspace,
  type RecoveryPresentationWorkspaceRef
} from '../../../shared/cross-machine-recovery-presentation-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { CrossMachineRecoveryPresentationStore } from './presentation-store'
import { readRecoveryActivity } from './recovery-activity'

const { current } = vi.hoisted(() => {
  const holder: { store: CrossMachineRecoveryPresentationStore | null } = { store: null }
  return { current: holder }
})

vi.mock('./presentation-store-instance', () => ({
  getCrossMachineRecoveryPresentationStore: () => current.store
}))

const NOW = 1_800_000_000_000
const FOLDER_ID = 'folder-repo::/src/notes::workspace:0f5c2d0e-8b1a-4c1e-9d6f-2a7b3c4d5e6f'

const emptyLayout: RecoveryLayout = {
  tabs: [],
  groups: [],
  groupLayout: null,
  activeGroupId: null,
  terminalTabs: [],
  terminalLayouts: {},
  startupCwdRelative: {},
  editors: [],
  activeEditorRelativePath: null,
  browsers: [],
  activeBrowserId: null,
  activeTabType: null,
  activeTabId: null
}

function workspace(
  ref: RecoveryPresentationWorkspaceRef,
  msSinceHumanInput: number | null,
  msSinceHumanFocus: number | null
): RecoveryPresentationWorkspace {
  return {
    workspace: ref,
    view: emptyLayout,
    focus: {
      isActiveWorkspace: false,
      focusedTabId: null,
      focusedLeafId: null,
      focusedPaneKey: null,
      windowFocused: false
    },
    input: { msSinceHumanInput, msSinceHumanFocus, msSinceHumanInputByPaneKey: {} }
  }
}

let store: CrossMachineRecoveryPresentationStore

async function publish(
  clientKey: string,
  hostReceivedAt: number,
  workspaces: RecoveryPresentationWorkspace[]
): Promise<void> {
  await store.record(
    clientKey,
    clientKey === 'local-renderer' ? 'local-renderer' : 'paired-device',
    {
      clientInstanceId: `${clientKey}-instance`,
      clientName: clientKey,
      clientRevision: 1,
      workspaces
    },
    hostReceivedAt
  )
}

function runtimeWith(repos: Partial<Repo>[], metaById: Record<string, Partial<WorktreeMeta>>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readRecoveryActivity reads only the store's repos and worktree meta from this host state.
  return {
    readCrossMachineRecoveryHostState: () => ({
      store: {
        getRepos: () => repos,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId]
      },
      agentStatuses: []
    })
  } as unknown as Parameters<typeof readRecoveryActivity>[0]
}

const localRepos: Partial<Repo>[] = [
  { id: 'repo', path: '/src/repo', connectionId: null },
  { id: 'folder-repo', path: '/src/notes', kind: 'folder' },
  { id: 'ssh-repo', path: '/home/me/repo', connectionId: 'ssh-1' }
]

describe('readRecoveryActivity', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xmr-activity-'))
    store = new CrossMachineRecoveryPresentationStore(directory)
    current.store = store
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('reports the newest input and focus across every client independently', async () => {
    const ref = {
      kind: 'worktree',
      worktreeId: 'repo::/src/repo/wt',
      instanceId: 'inst-1'
    } as const
    await publish('local-renderer', NOW, [workspace(ref, 1_000, 5_000)])
    await publish('device:phone', NOW - 60_000, [workspace(ref, 3_000, null)])
    await publish('device:tablet', NOW - 1_000, [workspace(ref, null, 200)])

    const result = await readRecoveryActivity(
      runtimeWith(localRepos, { 'repo::/src/repo/wt': { instanceId: 'inst-1' } }),
      NOW
    )

    expect(result).toEqual({
      workspaces: [
        {
          worktreeId: 'repo::/src/repo/wt',
          path: '/src/repo/wt',
          lastHumanInputAt: NOW - 1_000,
          lastHumanFocusAt: NOW - 1_200
        }
      ]
    })
  })

  it('keeps null stamps when no client saw a human', async () => {
    const ref = { kind: 'worktree', worktreeId: 'repo::/src/repo' } as const
    await publish('local-renderer', NOW, [workspace(ref, null, null)])

    expect(await readRecoveryActivity(runtimeWith(localRepos, {}), NOW)).toEqual({
      workspaces: [
        {
          worktreeId: 'repo::/src/repo',
          path: '/src/repo',
          lastHumanInputAt: null,
          lastHumanFocusAt: null
        }
      ]
    })
  })

  it('reports a folder workspace under its exportable id at the folder path', async () => {
    await publish('local-renderer', NOW, [
      workspace({ kind: 'folder', folderWorkspaceId: FOLDER_ID }, 4_000, 2_000)
    ])

    expect(await readRecoveryActivity(runtimeWith(localRepos, {}), NOW)).toEqual({
      workspaces: [
        {
          worktreeId: FOLDER_ID,
          path: '/src/notes',
          lastHumanInputAt: NOW - 4_000,
          lastHumanFocusAt: NOW - 2_000
        }
      ]
    })
  })

  it('drops SSH, unregistered, superseded-instance and expired workspaces', async () => {
    await publish('device:old', NOW - RECOVERY_PRESENTATION_RETENTION_MS - 1, [
      workspace({ kind: 'worktree', worktreeId: 'repo::/src/repo/expired' }, 0, 0)
    ])
    await publish('local-renderer', NOW, [
      workspace({ kind: 'worktree', worktreeId: 'ssh-repo::/home/me/repo' }, 0, 0),
      workspace({ kind: 'worktree', worktreeId: 'gone-repo::/src/gone' }, 0, 0),
      workspace(
        { kind: 'worktree', worktreeId: 'repo::/src/repo/reused', instanceId: 'old-instance' },
        0,
        0
      ),
      workspace({ kind: 'worktree', worktreeId: 'not-a-worktree-id' }, 0, 0)
    ])

    const result = await readRecoveryActivity(
      runtimeWith(localRepos, { 'repo::/src/repo/reused': { instanceId: 'new-instance' } }),
      NOW
    )

    expect(result).toEqual({ workspaces: [] })
  })
})
