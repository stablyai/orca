import type {
  RemoteWorkspaceObservedTab,
  RemoteWorkspaceObservedWorktree,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot,
  RemoteWorkspaceTerminalTab
} from '../../shared/remote-workspace-types'

export type RemoteWorkspaceTabIntent = {
  presence: 'present' | 'absent'
  processIdentity: string
  sequence: number
  tab: RemoteWorkspaceObservedTab
  worktree: Pick<
    RemoteWorkspaceObservedWorktree,
    'worktreeId' | 'worktreeInstanceId' | 'worktreePath'
  >
}

export function remoteTabIdentityMatches(
  left: RemoteWorkspaceTerminalTab,
  right: RemoteWorkspaceTerminalTab
): boolean {
  return (
    left.id === right.id &&
    left.createdAt === right.createdAt &&
    left.ptyId === right.ptyId &&
    left.generation === right.generation
  )
}

export function findObservedIntentWorktree(
  worktrees: ReadonlyMap<string, RemoteWorkspaceObservedWorktree>,
  intent: RemoteWorkspaceTabIntent
): RemoteWorkspaceObservedWorktree | undefined {
  const current = worktrees.get(intent.worktree.worktreeId)
  return current?.worktreeInstanceId === intent.worktree.worktreeInstanceId &&
    current.worktreePath === intent.worktree.worktreePath
    ? current
    : undefined
}

export function sessionTabMatchesIntent(
  session: RemoteWorkspaceSession,
  intent: RemoteWorkspaceTabIntent
): boolean {
  const tabs = session.tabsByWorktreePath[intent.worktree.worktreePath] ?? []
  const hasExactTab = tabs.some((tab) => remoteTabIdentityMatches(tab, intent.tab.tab))
  return intent.presence === 'present' ? hasExactTab : !hasExactTab
}

export function sessionMatchesTabObservation(
  worktrees: ReadonlyMap<string, RemoteWorkspaceObservedWorktree>,
  session: RemoteWorkspaceSession
): boolean {
  const reliableWorktrees = [...worktrees.values()].filter(
    (worktree) => worktree.worktreeInstanceId !== null
  )
  if (reliableWorktrees.length !== worktrees.size) {
    return false
  }
  const observedPaths = new Set(reliableWorktrees.map((worktree) => worktree.worktreePath))
  const sessionPaths = new Set(Object.keys(session.tabsByWorktreePath))
  if (
    observedPaths.size !== sessionPaths.size ||
    [...observedPaths].some((path) => !sessionPaths.has(path))
  ) {
    return false
  }
  return reliableWorktrees.every((worktree) => {
    const remoteTabs = session.tabsByWorktreePath[worktree.worktreePath] ?? []
    return (
      remoteTabs.length === worktree.tabs.length &&
      worktree.tabs.every((tab) =>
        remoteTabs.some((remoteTab) => remoteTabIdentityMatches(remoteTab, tab.tab))
      )
    )
  })
}

export function reconcileTabIntentSnapshot(
  worktrees: ReadonlyMap<string, RemoteWorkspaceObservedWorktree>,
  intents: ReadonlyMap<string, RemoteWorkspaceTabIntent>,
  snapshot: RemoteWorkspaceSnapshot
): RemoteWorkspaceSnapshot {
  const reconciled = structuredClone(snapshot)
  for (const intent of [...intents.values()].sort(
    (left, right) => left.sequence - right.sequence
  )) {
    const worktree = findObservedIntentWorktree(worktrees, intent)
    if (!worktree) {
      continue
    }
    const currentTab = worktree.tabs.find(
      (entry) =>
        remoteTabIdentityMatches(entry.tab, intent.tab.tab) &&
        entry.processIdentity === intent.processIdentity
    )
    const tabs = reconciled.session.tabsByWorktreePath[worktree.worktreePath] ?? []
    if (intent.presence === 'present' && currentTab) {
      const withoutReusedId = tabs.filter((tab) => tab.id !== currentTab.tab.id)
      reconciled.session.tabsByWorktreePath[worktree.worktreePath] = [
        ...withoutReusedId,
        structuredClone(currentTab.tab)
      ].sort((left, right) => left.sortOrder - right.sortOrder)
      if (currentTab.layout) {
        reconciled.session.terminalLayoutsByTabId[currentTab.tab.id] = structuredClone(
          currentTab.layout
        )
      }
    } else if (intent.presence === 'absent' && !currentTab) {
      const remaining = tabs.filter((tab) => !remoteTabIdentityMatches(tab, intent.tab.tab))
      reconciled.session.tabsByWorktreePath[worktree.worktreePath] = remaining
      if (!remaining.some((tab) => tab.id === intent.tab.tab.id)) {
        delete reconciled.session.terminalLayoutsByTabId[intent.tab.tab.id]
        if (reconciled.session.activeTabId === intent.tab.tab.id) {
          reconciled.session.activeTabId = null
        }
        if (
          reconciled.session.activeTabIdByWorktreePath?.[worktree.worktreePath] ===
          intent.tab.tab.id
        ) {
          reconciled.session.activeTabIdByWorktreePath[worktree.worktreePath] = null
        }
      }
    }
  }
  return reconciled
}
