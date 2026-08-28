// @vitest-environment happy-dom

/**
 * The data-safety end of STA-3593. Hydrating a target authorises workspace uploads
 * (`use-app-session-persistence.ts`), an upload is a `replace-session` patch
 * (`remote-workspace-relay-sync.ts`), and the host applies that by wholesale replacement. So a
 * client that hydrated on a snapshot whose tab rows it could not place would upload its incomplete
 * projection and DELETE the host tabs it failed to adopt.
 *
 * That is the asymmetry the design turns on: a suppressed upload is deferred and recoverable, a
 * wiped host snapshot is not. This asserts the upload itself never names an unplaced target —
 * through the real persistence gate, not the hydrated flag — so it still bites if the gating moves.
 */
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RemoteWorkspaceSnapshot } from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import type { DirectSshPreparationInput } from '../hooks/direct-ssh-reconnect-coordinator'
import { createRemoteWorkspaceTargetSync } from '../hooks/remote-workspace-target-sync'
import { makeWorktree } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

import { useAppStore } from '@/store'
import { useAppSessionPersistence } from './use-app-session-persistence'

const TARGET_ID = 'target-a'
const REPO_ROOT = '/srv/proj'
const HOST_PATH = `${REPO_ROOT}/alpha`
const WORKTREE_ID = `repo-a::${HOST_PATH}`
/** Long enough that any deferred retry or debounce would have fired if one existed. */
const SETTLE_MS = 12_000
/** Longer than the post-apply session-write suppression in remote-workspace-snapshot-apply.ts. */
const WRITE_SUPPRESSION_MS = 1_500
const DEBOUNCE_MS = 300

const owner: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'epoch-a' as SshProviderEpoch,
  connectionGeneration: 1
}

function snapshot(revision = 4): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    session: {
      activeWorktreePath: HOST_PATH,
      activeTabId: 'T1',
      tabsByWorktreePath: {
        [HOST_PATH]: [0, 1].map((index) => ({
          id: `T${index + 1}`,
          worktreePath: HOST_PATH,
          ptyId: `pty-T${index + 1}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {}
    }
  }
}

type UploadArgs = { hydratedTargetIds?: string[]; session?: unknown }
const uploads = vi.fn(async (_args: UploadArgs) => [] as { targetId: string; result: never }[])

function installWindowApi(): void {
  ;(window as unknown as { api: unknown }).api = {
    session: { patch: vi.fn(async () => {}), set: vi.fn(async () => {}) },
    remoteWorkspace: { setForConnectedTargets: uploads },
    app: { stageBeforeUnloadSync: vi.fn() },
    ui: { onWindowCloseRequested: vi.fn(() => () => {}) }
  }
}

function seedStore(withHostCatalog: boolean): void {
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    repos: [
      {
        id: 'repo-a',
        path: REPO_ROOT,
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID,
        executionHostId: `ssh:${TARGET_ID}`
      } as never
    ],
    worktreesByRepo: withHostCatalog
      ? {
          'repo-a': [
            makeWorktree({
              id: WORKTREE_ID,
              repoId: 'repo-a',
              path: HOST_PATH,
              hostId: `ssh:${TARGET_ID}`
            } as never)
          ]
        }
      : {},
    remoteWorkspaceHydratedTargetIds: new Set<string>(),
    remoteWorkspaceSyncStatusByTargetId: {},
    tabsByWorktree: {},
    reconnectPersistedTerminals: (async () => {}) as never
  })
}

function createSync() {
  return createRemoteWorkspaceTargetSync({
    store: useAppStore,
    remoteWorkspace: {
      get: vi.fn(async () => snapshot()),
      setForConnectedTargets: uploads as never
    },
    getCurrentAuthority: () => owner,
    isPreparationTokenCurrent: () => true,
    capturePreparationInput: async (
      authority,
      reason,
      snapshotRevision
    ): Promise<DirectSshPreparationInput> => ({
      ...authority,
      catalogRevision: 1,
      repoRefs: [{ repoId: 'repo-a', executionHostId: `ssh:${TARGET_ID}` }],
      authorityRequirement: 'required',
      reason,
      snapshotRevision
    }),
    prepareOnly: async (input) => ({
      status: 'degraded' as const,
      token: {
        authority: owner,
        catalogRevision: 1,
        repoFingerprint: 'fp',
        authorityRequirement: 'required' as const,
        snapshotRevision: input.snapshotRevision ?? null,
        outcome: 'degraded' as const
      },
      repoOutcomes: {
        complete: 0,
        'non-authoritative': 1,
        'timed-out': 0,
        'cancel-budget-exhausted': 0,
        canceled: 0,
        stale: 0,
        rejected: 0
      },
      lineageOutcome: 'degraded' as const
    }),
    finalizeHydratedTerminals: () => 0
  })
}

/** A local edit the persistence subscriber must want to write, then let it settle. */
async function touchSessionAndSettle(marker: string): Promise<void> {
  await vi.advanceTimersByTimeAsync(WRITE_SUPPRESSION_MS)
  useAppStore.setState({ activeTabId: marker })
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
}

function uploadedTargetIds(): string[] {
  return uploads.mock.calls.flatMap((call) => call[0]?.hydratedTargetIds ?? [])
}

beforeEach(() => {
  vi.useFakeTimers()
  uploads.mockClear()
  installWindowApi()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('uploads from a client that could not place the host tabs', () => {
  it('issues no upload for a target whose host tabs it could not place', async () => {
    seedStore(false)
    const persistence = renderHook(() => useAppSessionPersistence())
    const sync = createSync()

    // Deliberately not asserting the placement verdict first: the oracle is the upload, and a
    // precondition on the verdict would fail ahead of it and hide whether the upload gate holds.
    await sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())
    expect(
      useAppStore.getState().tabsByWorktree[WORKTREE_ID],
      'the host named two terminals and this client placed neither'
    ).toBeUndefined()

    // Before the client has settled: it is not authoritative for this target yet.
    await touchSessionAndSettle('mid-chain')
    expect(
      uploadedTargetIds(),
      'a client that adopted none of the host tabs uploaded over them'
    ).not.toContain(TARGET_ID)

    // Still no upload once everything has settled: not adopting is not permission to overwrite the host.
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(
      useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]?.phase,
      'a client that placed none of the host tabs reported a healthy sync'
    ).not.toBe('synced')
    await touchSessionAndSettle('settled')
    expect(
      uploadedTargetIds(),
      'settling authorised a replace-session upload built from an incomplete projection'
    ).not.toContain(TARGET_ID)

    sync.stop()
    persistence.unmount()
  })

  it('does upload for a target whose host tabs it did place', async () => {
    seedStore(true)
    const persistence = renderHook(() => useAppSessionPersistence())
    const sync = createSync()

    await sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())
    // Adoption is the observable outcome; the apply reports nothing back by design.
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual([
      'T1',
      'T2'
    ])

    await touchSessionAndSettle('placed')

    // Without this the suppression assertions above would pass on a harness that never uploads.
    expect(uploadedTargetIds()).toContain(TARGET_ID)

    sync.stop()
    persistence.unmount()
  })
})
