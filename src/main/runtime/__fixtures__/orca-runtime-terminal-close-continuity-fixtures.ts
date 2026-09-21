import { vi, type Mock } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-types'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  CANARY_INCARNATION_ID,
  CANARY_LEAF_ID,
  CANARY_PTY_ID,
  CANARY_TAB_ID,
  INCARNATION_ID,
  LEAF_ID,
  PTY_ID,
  REPO_ID,
  RUNTIME_OWNED_PTY_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_PTY_ID,
  STALE_TAB_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  canaryProcess,
  makeSession
} from './orca-runtime-terminal-close-continuity-state-fixture'
import { createCloseContinuityGraphFixture } from './orca-runtime-terminal-close-continuity-graph-fixture'

export {
  CANARY_INCARNATION_ID,
  CANARY_LEAF_ID,
  CANARY_PTY_ID,
  CANARY_TAB_ID,
  INCARNATION_ID,
  LEAF_ID,
  OTHER_WORKTREE_ID,
  PTY_ID,
  REPO_ID,
  RUNTIME_OWNED_PTY_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  STALE_TAB_ID,
  TAB_ID,
  WORKTREE_ID,
  WORKTREE_PATH,
  makeSession
} from './orca-runtime-terminal-close-continuity-state-fixture'

function makeDeferred() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

export type CloseContinuityHarness = {
  runtime: OrcaRuntimeService
  acknowledged: ReturnType<typeof makeDeferred>
  closeTerminal: Mock<(...args: unknown[]) => unknown>
  closeTerminalTab: Mock<(...args: unknown[]) => unknown>
  flushOrThrow: Mock<() => void>
  kill: Mock<(ptyId: string) => boolean>
  stopAndWait: Mock<(ptyId: string, ...args: unknown[]) => Promise<boolean | void>>
  syncCanaryGraph: () => void
  syncEmptyGraph: () => void
  syncFixtureGraph: () => void
  syncFixtureTabWithoutLeaf: () => void
  syncSplitFixtureGraph: () => void
  getSession: () => WorkspaceSessionState
  makeSessionUnavailable: () => void
  removeVictimFromInventory: () => void
  retirePersistedTab: () => void
  setCloseTerminalTabAction: (action: () => void | Promise<void>) => void
  rejectTerminalTabClose: (error: Error) => void
  rejectPersistenceFlush: (error: Error) => void
  setVerifiedStopResult: (result: boolean | Error) => void
  setStopAndWaitAction: (action: (stoppingPtyId: string) => void | Promise<void>) => void
  replaceIncarnation: (next: string) => void
  replacePersistedIncarnation: (next: string) => void
}

function createHarness(
  options: {
    ptyId?: string
    publishMobileSurface?: boolean
    registerPtyBacked?: boolean
    includeCanary?: boolean
  } = {}
): CloseContinuityHarness {
  const ptyId = options.ptyId ?? PTY_ID
  let session = makeSession(ptyId, options.includeCanary)
  let sessionAvailable = true
  let incarnationId = INCARNATION_ID
  let includeSiblingPty = false
  let victimPtyListed = true
  let flushError: Error | null = null
  const repo = {
    id: REPO_ID,
    path: WORKTREE_PATH,
    displayName: 'close-continuity',
    badgeColor: '#000000',
    addedAt: 1
  }
  const store = {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getProjects: () => [],
    getWorkspaceSession: () => (sessionAvailable ? session : undefined),
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    },
    flushOrThrow: vi.fn(() => {
      if (flushError) {
        throw flushError
      }
    })
  }
  const acknowledged = makeDeferred()
  let closeTerminalTabError: Error | null = null
  let closeTerminalTabAction: (() => void | Promise<void>) | null = null
  const closeTerminal = vi.fn()
  const closeTerminalTab = vi.fn(() => {
    if (closeTerminalTabError) {
      return Promise.reject(closeTerminalTabError)
    }
    return closeTerminalTabAction ? Promise.resolve(closeTerminalTabAction()) : acknowledged.promise
  })
  const kill = vi.fn(() => true)
  let verifiedStopResult: boolean | Error = false
  let stopAndWaitAction: ((stoppingPtyId: string) => void | Promise<void>) | null = null
  const stopAndWait = vi.fn(async (stoppingPtyId: string) => {
    await stopAndWaitAction?.(stoppingPtyId)
    if (verifiedStopResult instanceof Error) {
      throw verifiedStopResult
    }
    return verifiedStopResult
  })
  const listProcesses = vi.fn(async () => [
    ...(victimPtyListed
      ? [
          {
            id: ptyId,
            incarnationId,
            cwd: WORKTREE_PATH,
            title: 'Fixture shell'
          }
        ]
      : []),
    ...(includeSiblingPty
      ? [
          {
            id: SIBLING_PTY_ID,
            incarnationId: SIBLING_INCARNATION_ID,
            cwd: WORKTREE_PATH,
            title: 'Fixture sibling shell'
          }
        ]
      : []),
    ...(options.includeCanary ? [canaryProcess] : [])
  ])
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setNotifier({ closeTerminal, closeTerminalTab } as never)
  runtime.setPtyController({
    write: () => true,
    kill,
    stopAndWait,
    listProcesses,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)

  const graph = createCloseContinuityGraphFixture({
    runtime,
    ptyId,
    publishMobileSurface: options.publishMobileSurface,
    includeCanary: options.includeCanary,
    getSession: () => session,
    setSession: (next) => {
      session = next
    },
    markSiblingPtyIncluded: () => {
      includeSiblingPty = true
    }
  })

  if (options.registerPtyBacked) {
    runtime.registerPty(ptyId, WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID
    })
    if (options.includeCanary) {
      runtime.registerPty(CANARY_PTY_ID, WORKTREE_ID, null, {
        tabId: CANARY_TAB_ID,
        leafId: CANARY_LEAF_ID,
        incarnationId: CANARY_INCARNATION_ID
      })
    }
  }
  graph.syncFixtureGraph()
  return {
    runtime,
    acknowledged,
    closeTerminal,
    closeTerminalTab,
    flushOrThrow: store.flushOrThrow,
    kill,
    stopAndWait,
    ...graph,
    getSession: () => session,
    makeSessionUnavailable: () => {
      sessionAvailable = false
    },
    removeVictimFromInventory: () => {
      victimPtyListed = false
    },
    retirePersistedTab: () => {
      const victimPaneKey = makePaneKey(TAB_ID, LEAF_ID)
      session = {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [WORKTREE_ID]: (session.tabsByWorktree[WORKTREE_ID] ?? []).filter(
            (tab) => tab.id !== TAB_ID
          )
        },
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId).filter(([tabId]) => tabId !== TAB_ID)
        ),
        terminalPtyIncarnationsByPaneKey: Object.fromEntries(
          Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
            ([paneKey]) => paneKey !== victimPaneKey
          )
        )
      }
    },
    setCloseTerminalTabAction: (action: () => void | Promise<void>) => {
      closeTerminalTabAction = action
    },
    rejectTerminalTabClose: (error: Error) => {
      closeTerminalTabError = error
    },
    rejectPersistenceFlush: (error: Error) => {
      flushError = error
    },
    setVerifiedStopResult: (result: boolean | Error) => {
      verifiedStopResult = result
    },
    setStopAndWaitAction: (action: (stoppingPtyId: string) => void | Promise<void>) => {
      stopAndWaitAction = action
    },
    replaceIncarnation: (next: string) => {
      incarnationId = next
    },
    replacePersistedIncarnation: (next: string) => {
      session = {
        ...session,
        terminalPtyIncarnationsByPaneKey: {
          ...session.terminalPtyIncarnationsByPaneKey,
          [makePaneKey(TAB_ID, LEAF_ID)]: next
        }
      }
    }
  }
}

function createPtyBackedPublishedSurfaceHarness(): CloseContinuityHarness {
  const harness = createHarness({
    ptyId: RUNTIME_OWNED_PTY_ID,
    publishMobileSurface: true,
    registerPtyBacked: true
  })
  harness.syncFixtureTabWithoutLeaf()
  return harness
}

async function createStaleTabCloseHarness(
  options: { headless?: boolean } = {}
): Promise<CloseContinuityHarness & { terminal: RuntimeTerminalListResult['terminals'][number] }> {
  const harness = createPtyBackedPublishedSurfaceHarness()
  const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
    (candidate) => candidate.ptyId === RUNTIME_OWNED_PTY_ID
  )!
  harness.runtime.registerPty(RUNTIME_OWNED_PTY_ID, WORKTREE_ID, null, {
    tabId: STALE_TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID
  })
  harness.setCloseTerminalTabAction(() => {})
  if (options.headless) {
    harness.syncEmptyGraph()
  }
  return { ...harness, terminal }
}

export {
  makeDeferred,
  createHarness,
  createPtyBackedPublishedSurfaceHarness,
  createStaleTabCloseHarness
}
