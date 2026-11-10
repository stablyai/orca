import { TerminalIdentityHandoff } from '../../pty/terminal-identity-handoff'
import type { LegacyTerminalIdentityClaims } from './legacy-terminal-identity-claims'
import { LegacyTerminalBindingReplay } from './legacy-terminal-binding-replay'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { visibleTerminalRowIds } from '../../pty/legacy-terminal-topology-retirement'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { getPtyExecutionHost } from '../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { preserveMissingLeafRecordEntries } from '../restoring-sessions/terminal-layout-normalization'

import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'

type TerminalBindingRecovery = Pick<
  TerminalBindingRecoveryOperations,
  | 'getTerminalLayoutLeafIds'
  | 'getConnectionIdForWorktree'
  | 'isRestorablePtyBinding'
  | 'hasRestorableSshRemotePtyLease'
>

function collectAmbiguousTabIds(
  tabsByWorktree: WorkspaceSessionState['tabsByWorktree'],
  observe?: (
    workspace: string,
    row: WorkspaceSessionState['tabsByWorktree'][string][number]
  ) => void
): ReadonlySet<string> {
  const ownerByTabId = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      observe?.(worktreeId, tab)
      if (ownerByTabId.has(tab.id)) {
        ambiguous.add(tab.id)
      } else {
        ownerByTabId.set(tab.id, worktreeId)
      }
    }
  }
  return ambiguous
}

export type WorkspaceSessionTerminalBindingReplayOptions = {
  identityAuthority?: LegacyTerminalIdentityClaims
  retirePriorRow?: (
    workspace: string,
    row: WorkspaceSessionState['tabsByWorktree'][string][number],
    tabSurvives: boolean,
    retainedLeaves: ReadonlySet<string>
  ) => void
  targetIdForWorktree?: (worktreeId: string) => string | null
  executionHostId?: ExecutionHostId
  observeRow?: (
    workspace: string,
    row: WorkspaceSessionState['tabsByWorktree'][string][number],
    layout: WorkspaceSessionState['terminalLayoutsByTabId'][string] | undefined
  ) => void
  observeLayout?: (
    workspace: string | undefined,
    tabId: string,
    layout: WorkspaceSessionState['terminalLayoutsByTabId'][string]
  ) => void
  isLocalWorkspace?: (workspace: string) => boolean
}

function ptyBindingMatchesExecutionHost(
  ptyId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  if (!executionHostId || executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const owner = getPtyExecutionHost(ptyId)
  // Unscoped legacy IDs still need lease/context checks; known foreign IDs cannot cross hosts.
  return owner === null || owner === executionHostId
}

/** Recover stale empty maps unless retirement proves a close; partial maps need live SSH lease proof. */
export function preserveMissingWorkspaceSessionTerminalBindings(
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  bindingRecovery: TerminalBindingRecovery,
  options: WorkspaceSessionTerminalBindingReplayOptions = {}
): WorkspaceSessionState {
  const priorTabs = prior?.tabsByWorktree ?? {}
  const nextTabs = session.tabsByWorktree ?? {}
  const priorLayouts = prior?.terminalLayoutsByTabId ?? {}
  let nextLayouts = session.terminalLayoutsByTabId ?? {}
  const rebases = new LegacyTerminalBindingReplay(session, prior)
  // Cross-snapshot duplicates can be moves; duplicates within either snapshot make replay ambiguous.
  const survivingTabIds = new Set<string>()
  const handoff = new TerminalIdentityHandoff()
  const retainedLeaves = handoff.retained
  const priorRows: {
    workspace: string
    row: WorkspaceSessionState['tabsByWorktree'][string][number]
  }[] = []
  const visibleByWorkspace = new Map<string, Set<string>>()
  const ambiguousNext = collectAmbiguousTabIds(nextTabs, (workspace, row) => {
    let visible = visibleByWorkspace.get(workspace)
    if (!visible) {
      visible = visibleTerminalRowIds(workspace, prior ?? session, session)
      visibleByWorkspace.set(workspace, visible)
    }
    if (visible.has(row.id)) {
      survivingTabIds.add(
        JSON.stringify([normalizeWorkspaceSessionKeyToWorkspaceId(workspace), row.id])
      )
      if (options.retirePriorRow) {
        handoff.observe('after', workspace, row.id, session)
      }
    }
  })
  const ambiguousTabIds = new Set<string>([
    ...collectAmbiguousTabIds(priorTabs, (workspace, row) => {
      if (prior) {
        handoff.observe('before', workspace, row.id, prior)
      }
      priorRows.push({ workspace, row })
    }),
    ...ambiguousNext
  ])
  if (options.identityAuthority) {
    handoff.apply(options.identityAuthority)
  }
  for (const { workspace, row } of priorRows) {
    options.retirePriorRow?.(
      workspace,
      row,
      survivingTabIds.has(
        JSON.stringify([normalizeWorkspaceSessionKeyToWorkspaceId(workspace), row.id])
      ),
      retainedLeaves
    )
  }
  const targetIdForWorktree =
    options.targetIdForWorktree ??
    ((worktreeId: string) => bindingRecovery.getConnectionIdForWorktree(worktreeId))

  for (const [worktreeId, tabs] of Object.entries(nextTabs)) {
    const priorList = priorTabs[worktreeId]
    let priorById: Map<string, (typeof priorList)[number]> | undefined
    for (let [index, tab] of tabs.entries()) {
      if (priorList) {
        priorById ??= new Map(priorList.map((candidate) => [candidate.id, candidate]))
      }
      if (!ambiguousTabIds.has(tab.id) && priorById?.has(tab.id)) {
        if (options.isLocalWorkspace?.(worktreeId)) {
          tab = rebases.rebase(worktreeId, index, tab)
          session = rebases.session
          nextLayouts = session.terminalLayoutsByTabId ?? {}
        }
      }
      options.observeRow?.(worktreeId, tab, nextLayouts[tab.id])
      if (!priorList) {
        continue
      }
      if (ambiguousTabIds.has(tab.id)) {
        continue
      }
      if (tab.ptyId) {
        continue
      }
      priorById ??= new Map(priorList.map((candidate) => [candidate.id, candidate]))
      const priorTab = priorById.get(tab.id)
      const incomingLayout = nextLayouts[tab.id]
      const priorLayout = priorLayouts[tab.id]
      const priorPtyLeafId = priorLayout
        ? Object.entries(priorLayout.ptyIdsByLeafId ?? {}).find(
            ([, ptyId]) => ptyId === priorTab?.ptyId
          )?.[0]
        : undefined
      const bindingLeafWasRemoved =
        incomingLayout !== undefined &&
        priorPtyLeafId !== undefined &&
        !bindingRecovery.getTerminalLayoutLeafIds(incomingLayout.root).has(priorPtyLeafId)
      if (
        priorTab?.ptyId &&
        !bindingLeafWasRemoved &&
        ptyBindingMatchesExecutionHost(priorTab.ptyId, options.executionHostId) &&
        bindingRecovery.isRestorablePtyBinding({
          ptyId: priorTab.ptyId,
          worktreeId,
          targetId: targetIdForWorktree(worktreeId),
          tabId: tab.id
        })
      ) {
        tab.ptyId = priorTab.ptyId
        options.observeRow?.(worktreeId, tab, nextLayouts[tab.id])
      }
    }
  }

  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries({ ...priorTabs, ...nextTabs })) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }

  for (const [tabId, layout] of Object.entries(nextLayouts)) {
    options.observeLayout?.(
      ambiguousTabIds.has(tabId) ? undefined : worktreeIdByTabId.get(tabId),
      tabId,
      layout
    )
    if (ambiguousTabIds.has(tabId)) {
      continue
    }
    const priorLayout = priorLayouts[tabId]
    if (!priorLayout?.ptyIdsByLeafId) {
      continue
    }
    const incoming = layout.ptyIdsByLeafId ?? {}
    const incomingHasAnyBinding = Object.keys(incoming).length > 0
    const liveLeafIds = bindingRecovery.getTerminalLayoutLeafIds(layout.root)
    const worktreeId = worktreeIdByTabId.get(tabId)
    const targetId = worktreeId ? targetIdForWorktree(worktreeId) : null
    const restorableBindings = Object.fromEntries(
      Object.entries(priorLayout.ptyIdsByLeafId).filter(
        ([leafId, ptyId]) =>
          liveLeafIds.has(leafId) &&
          incoming[leafId] === undefined &&
          ptyBindingMatchesExecutionHost(ptyId, options.executionHostId) &&
          (incomingHasAnyBinding
            ? bindingRecovery.hasRestorableSshRemotePtyLease({
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              })
            : bindingRecovery.isRestorablePtyBinding({
                ptyId,
                targetId,
                worktreeId,
                tabId,
                leafId
              }))
      )
    )
    if (Object.keys(restorableBindings).length === 0) {
      continue
    }

    layout.ptyIdsByLeafId = { ...restorableBindings, ...incoming }
    options.observeLayout?.(worktreeId, tabId, layout)
    const buffersByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.buffersByLeafId,
      layout.buffersByLeafId,
      liveLeafIds
    )
    const scrollbackRefsByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.scrollbackRefsByLeafId,
      layout.scrollbackRefsByLeafId,
      liveLeafIds
    )
    const titlesByLeafId = preserveMissingLeafRecordEntries(
      priorLayout.titlesByLeafId,
      layout.titlesByLeafId,
      liveLeafIds
    )
    if (buffersByLeafId) {
      layout.buffersByLeafId = buffersByLeafId
    }
    if (scrollbackRefsByLeafId) {
      layout.scrollbackRefsByLeafId = scrollbackRefsByLeafId
    }
    if (titlesByLeafId) {
      layout.titlesByLeafId = titlesByLeafId
    }
  }

  return session
}

export function sshTargetIdForWorkspaceSessionHost(
  hostId: ExecutionHostId
): ((worktreeId: string) => string | null) | undefined {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? () => parsed.targetId : () => null
}
