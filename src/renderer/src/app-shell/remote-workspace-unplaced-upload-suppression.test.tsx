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
import type {
  RemoteWorkspaceObservedPatchResult,
  RemoteWorkspaceObservedSnapshot
} from '../../../shared/remote-workspace-types'
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

function snapshot(
  revision = 4,
  hostObservationToken = `observation-${revision}`
): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken,
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

type UploadArgs = {
  hydratedTargetIds?: string[]
  expectedRevisionsByTargetId?: Record<string, number>
  expectedHostObservationTokensByTargetId?: Record<string, string>
  session?: unknown
}
type UploadResponse = { targetId: string; result: RemoteWorkspaceObservedPatchResult }[]
const uploads = vi.fn(async (_args: UploadArgs): Promise<UploadResponse> => [])

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function installWindowApi(sessionPatch = vi.fn(async () => {})): void {
  ;(window as unknown as { api: unknown }).api = {
    session: { patch: sessionPatch, set: vi.fn(async () => {}) },
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

function preparationInput(
  authority: DirectSshAuthority,
  reason: 'workspace-snapshot',
  snapshotRevision: number
): DirectSshPreparationInput {
  return {
    ...authority,
    catalogRevision: 1,
    repoRefs: [{ repoId: 'repo-a', executionHostId: `ssh:${TARGET_ID}` }],
    authorityRequirement: 'required',
    reason,
    snapshotRevision
  }
}

function createSync(
  capturePreparationInput = async (
    authority: DirectSshAuthority,
    reason: 'workspace-snapshot',
    snapshotRevision: number
  ): Promise<DirectSshPreparationInput> => preparationInput(authority, reason, snapshotRevision)
) {
  return createRemoteWorkspaceTargetSync({
    store: useAppStore,
    remoteWorkspace: {
      get: vi.fn(async () => snapshot()),
      setForConnectedTargets: uploads as never
    },
    getCurrentAuthority: () => owner,
    isPreparationTokenCurrent: () => true,
    capturePreparationInput,
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function uploadedTargetIds(): string[] {
  return uploads.mock.calls.flatMap((call) => call[0]?.hydratedTargetIds ?? [])
}

function authorizeUploadsAtRevision(revision: number): void {
  useAppStore.setState({
    remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
    remoteWorkspaceSyncStatusByTargetId: {
      [TARGET_ID]: {
        phase: 'synced',
        direction: 'pull',
        revision,
        hostObservationToken: `observation-${revision}`
      }
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  uploads.mockReset()
  uploads.mockResolvedValue([])
  installWindowApi()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('uploads from a client that could not place the host tabs', () => {
  it('cancels a captured upload when a snapshot arrives during its local write', async () => {
    seedStore(true)
    authorizeUploadsAtRevision(3)
    const pendingLocalWrite = deferred<void>()
    const sessionPatch = vi.fn(() => pendingLocalWrite.promise)
    installWindowApi(sessionPatch)
    const persistence = renderHook(() => useAppSessionPersistence())

    useAppStore.setState({ activeTabId: 'before-snapshot' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(sessionPatch).toHaveBeenCalled()

    const pendingCapture = deferred<DirectSshPreparationInput>()
    const sync = createSync(() => pendingCapture.promise)
    const pendingApply = sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())
    pendingLocalWrite.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(
      uploadedTargetIds(),
      'an upload captured before the incoming revision overwrote its cached tabs'
    ).not.toContain(TARGET_ID)

    sync.stop()
    pendingCapture.resolve(preparationInput(owner, 'workspace-snapshot', 4))
    await pendingApply
    persistence.unmount()
  })

  it('excludes an incoming snapshot target while preparation is pending', async () => {
    seedStore(true)
    authorizeUploadsAtRevision(3)
    const persistence = renderHook(() => useAppSessionPersistence())
    const pendingCapture = deferred<DirectSshPreparationInput>()
    const sync = createSync(() => pendingCapture.promise)

    const pendingApply = sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())
    await touchSessionAndSettle('capture-pending')

    expect(
      uploadedTargetIds(),
      'the cached incoming revision was overwritten before its tabs could be applied'
    ).not.toContain(TARGET_ID)

    pendingCapture.resolve(preparationInput(owner, 'workspace-snapshot', 4))
    await pendingApply
    sync.stop()
    persistence.unmount()
  })

  it('issues no upload for a target whose host tabs it could not place', async () => {
    seedStore(false)
    const persistence = renderHook(() => useAppSessionPersistence())
    const sync = createSync()

    // Deliberately not asserting the placement verdict first: the oracle is the upload, and a
    // precondition on the verdict would fail ahead of it and hide whether the upload gate holds.
    const pendingApply = sync.applyUnsolicitedSnapshot(TARGET_ID, snapshot())
    await vi.advanceTimersByTimeAsync(10_000)
    await pendingApply
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
    expect(uploads).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevisionsByTargetId: { [TARGET_ID]: 4 },
        expectedHostObservationTokensByTargetId: {
          [TARGET_ID]: 'observation-4'
        }
      })
    )

    sync.stop()
    persistence.unmount()
  })

  it('keeps a later same-lineage upload after the earlier result advances the revision', async () => {
    seedStore(true)
    authorizeUploadsAtRevision(7)
    const secondLocalWrite = deferred<void>()
    let localWriteCount = 0
    const sessionPatch = vi.fn(() => {
      localWriteCount += 1
      return localWriteCount === 2 ? secondLocalWrite.promise : Promise.resolve()
    })
    const firstUpload = deferred<UploadResponse>()
    uploads.mockImplementationOnce(() => firstUpload.promise)
    uploads.mockResolvedValueOnce([
      {
        targetId: TARGET_ID,
        result: { ok: true, snapshot: snapshot(9, 'observation-7') }
      }
    ])
    installWindowApi(sessionPatch)
    const persistence = renderHook(() => useAppSessionPersistence())

    await vi.advanceTimersByTimeAsync(WRITE_SUPPRESSION_MS)
    useAppStore.setState({ activeTabId: 'first-local-write' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(uploads).toHaveBeenCalledOnce()

    useAppStore.setState({ activeTabId: 'second-local-write' })
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(sessionPatch).toHaveBeenCalledTimes(2)
    expect(uploads).toHaveBeenCalledOnce()

    firstUpload.resolve([
      {
        targetId: TARGET_ID,
        result: { ok: true, snapshot: snapshot(8, 'observation-7') }
      }
    ])
    await flushMicrotasks()
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'synced',
      revision: 8,
      hostObservationToken: 'observation-7'
    })

    secondLocalWrite.resolve()
    await flushMicrotasks()
    expect(uploads).toHaveBeenCalledTimes(2)
    expect(uploads.mock.calls[1][0]).toMatchObject({
      expectedRevisionsByTargetId: { [TARGET_ID]: 7 },
      expectedHostObservationTokensByTargetId: { [TARGET_ID]: 'observation-7' }
    })
    await flushMicrotasks()
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'synced',
      revision: 9,
      hostObservationToken: 'observation-7'
    })

    persistence.unmount()
  })

  it('retains transient upload authority so the next local edit retries', async () => {
    seedStore(true)
    authorizeUploadsAtRevision(7)
    uploads.mockResolvedValueOnce([
      {
        targetId: TARGET_ID,
        result: { ok: false, reason: 'unavailable', message: 'temporary relay failure' }
      }
    ])
    uploads.mockResolvedValueOnce([
      {
        targetId: TARGET_ID,
        result: { ok: true, snapshot: snapshot(8, 'observation-7') }
      }
    ])
    const persistence = renderHook(() => useAppSessionPersistence())

    await touchSessionAndSettle('transient-failure')
    await flushMicrotasks()
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'offline',
      revision: 7,
      hostObservationToken: 'observation-7'
    })

    await touchSessionAndSettle('retry-after-transient-failure')
    await flushMicrotasks()
    expect(uploads).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'synced',
      revision: 8,
      hostObservationToken: 'observation-7'
    })

    persistence.unmount()
  })
})
