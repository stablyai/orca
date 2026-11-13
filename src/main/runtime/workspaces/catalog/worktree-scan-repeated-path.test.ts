// Git lists a path twice when a linked registration's gitdir names the main checkout (#23631).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../../shared/constants'
import { Store } from '../../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore
} from '../../../persistence/persistence-test-harness'
import { hostWorktreeTargetForRepo } from '../../../persistence/host-qualified-worktree-meta'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('electron', () => electronMocks)

const localScanMock = vi.hoisted(() => vi.fn())
const pathPresenceMock = vi.hoisted(() => vi.fn())
vi.mock('../../../workspaces/catalog/local-worktree-path-presence', () => ({
  localWorktreePathsExistOrAreUnverifiable: pathPresenceMock
}))
vi.mock('./repo-worktree-resolution-scan', async (importOriginal) => ({
  ...(await importOriginal<typeof ResolutionScan>()),
  scanLocalRepoWorktreesForResolution: localScanMock
}))

vi.mock('./repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

import { OrcaRuntimeService } from '../../orca-runtime'
import type * as ResolutionScan from './repo-worktree-resolution-scan'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeWorktreeMeta,
  type PartialRuntimeStore
} from '../../orca-runtime-tests/runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Repo } from '../../../../shared/repo-types'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { holdInFlightWorktreeCreate } from '../../../workspaces/creation/worktree-create-in-flight'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import { bumpWorktreeScanGeneration } from '../../../git/worktrees/catalog/worktree-scan-cache'
import * as removalListing from '../../../workspaces/removal/worktree-removal-listing'
import { _resetWorktreeCatalogOwnerForTests } from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { isLocalWorktreeMetadataPruneDue } from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'

const REPO_ID = 'repo-local'
const REPO_PATH = '/home/me/fileLoc'
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`
const MAIN_ROW = {
  path: REPO_PATH,
  head: 'abc',
  branch: 'refs/heads/dev_ops',
  isBare: false,
  isMainWorktree: true
}

function makeRuntime(
  options: { connectionId?: string } = {},
  metaById: Record<string, WorktreeMeta> = {},
  onWrite?: (id: string) => void
): OrcaRuntimeService {
  const repos = [
    {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'fileLoc',
      badgeColor: 'blue',
      addedAt: 1,
      ...options
    }
  ]
  const store: PartialRuntimeStore = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      onWrite?.(id)
      metaById[id] = { ...storeWorktreeMeta(), ...metaById[id], ...meta }
      return metaById[id]
    },
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  return new OrcaRuntimeService(partialRuntimeStore(store))
}

function gitLists(worktrees: GitWorktreeInfo[]): void {
  localScanMock.mockResolvedValue({ ok: true, worktrees })
}

async function listedRows(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listManagedWorktrees()
  return listed.worktrees.map((worktree) => `${worktree.id} ${worktree.branch}`)
}

function realStoreRuntime(population: number) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-runtime-prune-')))
  const dataFile = join(dir, 'state.json')
  const repo: Repo = {
    id: REPO_ID,
    path: REPO_PATH,
    displayName: 'fileLoc',
    badgeColor: 'blue',
    addedAt: 1
  }
  writeFileSync(
    dataFile,
    JSON.stringify({
      ...getDefaultPersistedState(dir),
      repos: [repo],
      worktreeMeta: Object.fromEntries(
        Array.from({ length: population }, (_, index) => {
          const id = `${REPO_ID}::${REPO_PATH}/saved-${index}`
          return [id, storeWorktreeMeta({ hostId: 'local', instanceId: id })]
        })
      )
    })
  )
  const store = createSqliteTestStore(Store, { dataFile })
  return { store, repo, runtime: new OrcaRuntimeService(store) }
}

describe('worktree scan with a repeated path', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetWorktreeCatalogOwnerForTests()
    localScanMock.mockReset()
    pathPresenceMock.mockImplementation(
      async (paths: readonly string[]) => new Map(paths.map((path) => [path, false]))
    )
  })

  afterEach(async () => {
    vi.useRealTimers()
    await closeTestStores()
  })

  it('accepts equivalent routes, reuses their graph, and rejects a genuinely overtaken producer', async () => {
    vi.useFakeTimers({ now: 100_000, toFake: ['Date'] })
    const { store, runtime } = realStoreRuntime(1)
    store.updateRepo({ id: REPO_ID }, { externalWorktreeVisibility: 'show' })
    const current = store.getRepos()[0]!
    const owners = vi.spyOn(store, 'getRepos').mockReturnValue([current])
    const acceptedPath = `${REPO_PATH}/accepted`
    let attempts = 0
    localScanMock.mockImplementation(async () => {
      attempts += 1
      // Exercise an adversarial reader transition; the public update API does not set this field.
      owners.mockReturnValue([{ ...current, connectionId: '' }])
      return {
        ok: true,
        worktrees: [{ ...MAIN_ROW, path: acceptedPath, isMainWorktree: false }]
      }
    })
    expect(await listedRows(runtime)).toEqual([`${REPO_ID}::${acceptedPath} refs/heads/dev_ops`])
    expect(attempts).toBe(1)
    expect(store.getWorktreeMetaForHost(`${REPO_ID}::${acceptedPath}`, 'local')).toMatchObject({
      gitWorktree: { isBare: false, branch: 'refs/heads/dev_ops' }
    })
    const writes = vi.spyOn(store, 'setWorktreeMeta')
    owners.mockReturnValue([current])
    vi.setSystemTime(102_000)
    expect(await listedRows(runtime)).toEqual([`${REPO_ID}::${acceptedPath} refs/heads/dev_ops`])
    expect(attempts).toBe(1)
    expect(writes).not.toHaveBeenCalled()
    expect(store.getWorktreeMetaForHost(`${REPO_ID}::${REPO_PATH}/saved-0`, 'local')).toBeDefined()
    owners.mockRestore()
    runWorktreeChangeInvalidators(REPO_ID)
    const rejectedPath = `${REPO_PATH}/overtaken`
    const successorPath = `${REPO_PATH}/after-update`
    let subsequentAttempts = 0
    localScanMock.mockImplementation(async () => {
      subsequentAttempts += 1
      if (subsequentAttempts === 1) {
        store.updateRepo({ id: REPO_ID }, { executionHostId: 'local' })
      }
      return {
        ok: true,
        worktrees: [
          {
            ...MAIN_ROW,
            path: subsequentAttempts === 1 ? rejectedPath : successorPath,
            isMainWorktree: false
          }
        ]
      }
    })
    expect(await listedRows(runtime)).toEqual([`${REPO_ID}::${successorPath} refs/heads/dev_ops`])
    expect(subsequentAttempts).toBe(2)
    expect(localScanMock).toHaveBeenCalledTimes(3)
    expect(store.getWorktreeMetaForHost(`${REPO_ID}::${rejectedPath}`, 'local')).toBeUndefined()
    expect(store.getWorktreeMetaForHost(`${REPO_ID}::${successorPath}`, 'local')).toMatchObject({
      gitWorktree: { isBare: false, branch: 'refs/heads/dev_ops' }
    })
  })

  it.each([750, 7500])(
    'takes no destructive metadata snapshots on ordinary warm and joined reads with %i saved rows',
    async (population) => {
      vi.useFakeTimers({ now: 100_000, toFake: ['Date'] })
      const { store, runtime } = realStoreRuntime(population)
      const capture = vi.spyOn(store, 'captureNativeLocalWorktreeMetadataScanExpectation')
      gitLists([MAIN_ROW])
      expect(await listedRows(runtime)).toEqual([`${MAIN_WORKTREE_ID} refs/heads/dev_ops`])
      expect(capture).not.toHaveBeenCalled()
      expect(localScanMock).toHaveBeenCalledTimes(1)
      // Expire only the resolved fleet snapshot, leaving the raw scan within its TTL.
      vi.setSystemTime(102_000)
      expect(await listedRows(runtime)).toEqual([`${MAIN_WORKTREE_ID} refs/heads/dev_ops`])
      expect(localScanMock).toHaveBeenCalledTimes(1)
      expect(capture).not.toHaveBeenCalled()
      expect(await runtime.showManagedWorktree(`id:${MAIN_WORKTREE_ID}`)).toMatchObject({
        id: MAIN_WORKTREE_ID
      })
      expect(capture).not.toHaveBeenCalled()
      const rawAuthority = await runtime.prepareStructuredAgentSessionRevealWorkspace({
        workspaceId: MAIN_WORKTREE_ID,
        executionHostId: 'local',
        wslDistro: null,
        workspaceKind: 'git-worktree'
      })
      expect(rawAuthority.current()).toBe(true)
      rawAuthority.release()
      expect(capture).not.toHaveBeenCalled()
      runWorktreeChangeInvalidators(REPO_ID)
      let finish!: (value: { ok: true; worktrees: GitWorktreeInfo[] }) => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      localScanMock.mockImplementationOnce(() => {
        entered()
        return new Promise((resolve) => {
          finish = resolve
        })
      })
      const producer = listedRows(runtime)
      await started
      const joined = runtime.showManagedWorktree(`id:${MAIN_WORKTREE_ID}`)
      finish({ ok: true, worktrees: [MAIN_ROW] })
      expect(await producer).toEqual([`${MAIN_WORKTREE_ID} refs/heads/dev_ops`])
      expect(await joined).toMatchObject({ id: MAIN_WORKTREE_ID })
      expect(localScanMock).toHaveBeenCalledTimes(2)
      expect(capture).not.toHaveBeenCalled()
      expect(
        store.getWorktreeMetaForHost(`${REPO_ID}::${REPO_PATH}/saved-0`, 'local')
      ).toBeDefined()
    }
  )

  it('captures each detected attempt before scanning and revalidates changed metadata before pruning', async () => {
    const { store, runtime, repo } = realStoreRuntime(3)
    const changedId = `${REPO_ID}::${REPO_PATH}/saved-0`
    const missingId = `${REPO_ID}::${REPO_PATH}/saved-1`
    const capture = vi.spyOn(store, 'captureNativeLocalWorktreeMetadataScanExpectation')
    let attempts = 0
    let capturedBeforePhase = 0
    localScanMock.mockImplementation(async () => {
      attempts += 1
      expect(capture).toHaveBeenCalledTimes(attempts - capturedBeforePhase)
      if (attempts === 1) {
        runWorktreeChangeInvalidators(REPO_ID)
      } else {
        store.setWorktreeMeta(hostWorktreeTargetForRepo(changedId, repo), {
          comment: 'changed during scan'
        })
      }
      return { ok: true, worktrees: [MAIN_ROW] }
    })
    expect(await runtime.listDetectedManagedWorktrees(REPO_ID)).toMatchObject({
      authoritative: true
    })
    expect(attempts).toBe(2)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.results[0].value).not.toBe(capture.mock.results[1].value)
    expect(store.getWorktreeMetaForHost(changedId, 'local')?.comment).toBe('changed during scan')
    expect(store.getWorktreeMetaForHost(missingId, 'local')).toBeUndefined()
    expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(true)
    const previousExpectation = capture.mock.results[1].value
    capturedBeforePhase = attempts
    capture.mockClear()
    expect(await runtime.listDetectedManagedWorktrees(REPO_ID)).toMatchObject({
      authoritative: true
    })
    // Releasing the overtaken claim rearms hygiene; only a fresh pre-scan capture can satisfy it.
    expect(attempts).toBe(3)
    expect(localScanMock).toHaveBeenCalledTimes(3)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.results[0].value).not.toBe(previousExpectation)
    expect(isLocalWorktreeMetadataPruneDue(REPO_ID)).toBe(false)
    capturedBeforePhase = attempts
    capture.mockClear()
    expect(await runtime.listDetectedManagedWorktrees(REPO_ID)).toMatchObject({
      authoritative: true
    })
    await runtime.listManagedWorktrees()
    expect(capture).not.toHaveBeenCalled()
    expect(attempts).toBe(3)
    expect(localScanMock).toHaveBeenCalledTimes(3)
  })

  it('keeps the raw held bare entry available to saved chat authority with its existing retry bound', async () => {
    const path = `${REPO_PATH}/.bare`
    const id = `${REPO_ID}::${path}`
    const metaById = { [id]: storeWorktreeMeta({ hostId: 'local', instanceId: 'retained-bare' }) }
    const runtime = makeRuntime({}, metaById)
    const release = await holdInFlightWorktreeCreate(REPO_ID, path, () => {
      runWorktreeChangeInvalidators(REPO_ID)
      bumpWorktreeScanGeneration(REPO_PATH)
    })
    const location: AgentSessionExecutionLocation = {
      workspaceId: id,
      executionHostId: 'local',
      wslDistro: null,
      workspaceKind: 'git-worktree' as const
    }
    gitLists([{ ...MAIN_ROW, path, branch: '', isBare: true }])
    try {
      const authority = await runtime.prepareStructuredAgentSessionRevealWorkspace(location)
      expect(authority.current()).toBe(true)
      authority.release()
      runWorktreeChangeInvalidators(REPO_ID)
      let reads = 0
      localScanMock.mockImplementation(async () => {
        reads += 1
        runWorktreeChangeInvalidators(REPO_ID)
        return { ok: true, worktrees: [{ ...MAIN_ROW, path, branch: '', isBare: true }] }
      })
      await expect(
        runtime.prepareStructuredAgentSessionRevealWorkspace(location)
      ).rejects.toMatchObject({ reason: 'obsolete' })
      expect(reads).toBe(3)
      expect(metaById[id].instanceId).toBe('retained-bare')
    } finally {
      release()
    }
  })

  it.each(['ordinary', 'detected'] as const)(
    'bounds %s delivery churn and projects only saved rows without adoption',
    async (mode) => {
      const savedPath = `${REPO_PATH}/saved`
      const creatingPath = `${REPO_PATH}/creating`
      const savedId = `${REPO_ID}::${savedPath}`
      const saved = storeWorktreeMeta({
        hostId: 'local',
        instanceId: 'saved-original',
        comment: 'retained content',
        gitWorktree: {
          isBare: false,
          isMainWorktree: true,
          branch: MAIN_ROW.branch,
          prunable: false
        }
      })
      const metaById = { [savedId]: saved }
      const writes = vi.fn()
      const runtime = makeRuntime({}, metaById, writes)
      const release = await holdInFlightWorktreeCreate(REPO_ID, creatingPath, () => {
        runWorktreeChangeInvalidators(REPO_ID)
        bumpWorktreeScanGeneration(REPO_PATH)
      })
      let reads = 0
      localScanMock.mockImplementation(async () => {
        reads += 1
        if (reads === 1 || reads === 3) {
          runWorktreeChangeInvalidators(REPO_ID)
        }
        return {
          ok: true,
          worktrees: [
            { ...MAIN_ROW, path: savedPath },
            { ...MAIN_ROW, path: creatingPath }
          ]
        }
      })
      const augment = removalListing.withUnregisteredRemovalCheckouts
      vi.spyOn(removalListing, 'withUnregisteredRemovalCheckouts').mockImplementationOnce(
        async (id, rows) => {
          const result = await augment(id, rows)
          runWorktreeChangeInvalidators(REPO_ID)
          return result
        }
      )
      try {
        const result =
          mode === 'ordinary'
            ? await runtime.listManagedWorktrees()
            : await runtime.listDetectedManagedWorktrees(REPO_ID)
        expect(result.worktrees.map((row) => row.path)).toEqual([savedPath])
        if ('authoritative' in result) {
          expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
        }
        expect(reads).toBe(3)
        expect(writes).not.toHaveBeenCalled()
        expect(metaById).toEqual({ [savedId]: saved })
        release()
        const settled = await runtime.listManagedWorktrees()
        expect(settled.worktrees.map((row) => row.path).sort()).toEqual(
          [savedPath, creatingPath].sort()
        )
        expect(writes).toHaveBeenCalledWith(`${REPO_ID}::${creatingPath}`)
        const afterSettlement = reads
        await runtime.listManagedWorktrees()
        expect(reads).toBe(afterSettlement)
      } finally {
        release()
      }
    }
  )

  it('does not adopt a pre-release raw read and later discovers the remaining checkout', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtime = makeRuntime({}, metaById)
    const path = `${REPO_PATH}/creating`
    const release = await holdInFlightWorktreeCreate(REPO_ID, path, () => {
      runWorktreeChangeInvalidators(REPO_ID)
      bumpWorktreeScanGeneration(REPO_PATH)
    })
    let entered!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finish!: (result: { ok: true; worktrees: GitWorktreeInfo[] }) => void
    localScanMock.mockImplementationOnce(() => {
      entered()
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    localScanMock.mockResolvedValue({
      ok: true,
      worktrees: [{ ...MAIN_ROW, path: `${path}-fresh` }]
    })
    try {
      const result = listedRows(runtime)
      await reading
      release()
      finish({ ok: true, worktrees: [{ ...MAIN_ROW, path }] })
      expect(await result).toEqual([`${REPO_ID}::${path}-fresh refs/heads/dev_ops`])
      expect(metaById[`${REPO_ID}::${path}`]).toBeUndefined()
      gitLists([{ ...MAIN_ROW, path }])
      runWorktreeChangeInvalidators(REPO_ID)
      expect(await listedRows(runtime)).toEqual([`${REPO_ID}::${path} refs/heads/dev_ops`])
      expect(metaById[`${REPO_ID}::${path}`].gitWorktree).toMatchObject({
        branch: 'refs/heads/dev_ops',
        isBare: false
      })
    } finally {
      release()
    }
  })

  it('retires a result released during removal augmentation before the identity join', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtime = makeRuntime({}, metaById)
    const path = `${REPO_PATH}/creating`
    gitLists([{ ...MAIN_ROW, path }])
    let entered!: () => void
    const augmenting = new Promise<void>((resolve) => {
      entered = resolve
    })
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    vi.spyOn(removalListing, 'withUnregisteredRemovalCheckouts').mockImplementationOnce(
      async (_, rows) => {
        entered()
        await completion
        return rows
      }
    )
    const result = listedRows(runtime)
    await augmenting
    const release = await holdInFlightWorktreeCreate(REPO_ID, path, () => {
      runWorktreeChangeInvalidators(REPO_ID)
      bumpWorktreeScanGeneration(REPO_PATH)
    })
    release()
    gitLists([{ ...MAIN_ROW, path: `${path}-fresh` }])
    finish()
    expect(await result).toEqual([`${REPO_ID}::${path}-fresh refs/heads/dev_ops`])
    // The raw scan may legitimately record the old row before the hold starts; the stale delivery cannot recreate it.
    expect(metaById[`${REPO_ID}::${path}-fresh`]?.gitWorktree).toMatchObject({
      branch: 'refs/heads/dev_ops'
    })
  })

  it('keeps the main checkout over a stale registration on another branch', async () => {
    gitLists([
      MAIN_ROW,
      { ...MAIN_ROW, head: 'old', branch: 'refs/heads/stale', isMainWorktree: false }
    ])
    const runtime = makeRuntime()

    await expect(listedRows(runtime)).resolves.toEqual([`${MAIN_WORKTREE_ID} refs/heads/dev_ops`])
    await expect(runtime.showManagedWorktree('branch:stale')).rejects.toThrow('selector_not_found')
  })

  it('records a real resolution scan for cold fallback without adopting a detached or bare entry', async () => {
    const bareId = `${REPO_ID}::${REPO_PATH}/.bare`
    const metaById = {
      [bareId]: storeWorktreeMeta({
        hostId: 'local',
        instanceId: 'original-bare',
        comment: 'saved'
      })
    }
    gitLists([
      { ...MAIN_ROW, path: `${REPO_PATH}/.bare`, isBare: true, branch: '' },
      { ...MAIN_ROW, path: `${REPO_PATH}/topic`, isMainWorktree: false },
      { ...MAIN_ROW, path: `${REPO_PATH}/detached`, isMainWorktree: false, branch: '' }
    ])
    const online = makeRuntime({}, metaById)
    const expected = [`${REPO_ID}::${REPO_PATH}/topic refs/heads/dev_ops`]
    await expect(listedRows(online)).resolves.toEqual(expected)
    expect(metaById[bareId]).toMatchObject({
      instanceId: 'original-bare',
      comment: 'saved',
      gitWorktree: { isBare: true, isMainWorktree: true, branch: '', prunable: false }
    })
    const coldMeta = structuredClone(metaById)
    _resetWorktreeCatalogOwnerForTests()
    localScanMock.mockResolvedValue({ ok: false, worktrees: [] })
    await expect(listedRows(makeRuntime({}, coldMeta))).resolves.toEqual(expected)
    expect(coldMeta[bareId]).toEqual(metaById[bareId])
    expect(Object.keys(coldMeta).sort()).toEqual([bareId, `${REPO_ID}::${REPO_PATH}/topic`].sort())
  })

  it('does not initialize a successor incarnation from an in-flight resolution scan', async () => {
    const id = `${REPO_ID}::${REPO_PATH}/topic`
    const metaById = { [id]: storeWorktreeMeta({ instanceId: 'old' }) }
    localScanMock.mockImplementation(async () => {
      metaById[id] = storeWorktreeMeta({ instanceId: 'new', comment: 'successor' })
      return { ok: true, worktrees: [{ ...MAIN_ROW, path: `${REPO_PATH}/topic` }] }
    })
    await listedRows(makeRuntime({}, metaById))
    expect(metaById[id]).toMatchObject({ instanceId: 'new', comment: 'successor' })
    expect(metaById[id]).not.toHaveProperty('gitWorktree')
  })
})
