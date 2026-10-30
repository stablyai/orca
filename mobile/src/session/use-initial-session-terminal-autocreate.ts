import { useEffect, useEffectEvent, useReducer, type RefObject } from 'react'
import { shouldAutoCreateInitialSessionTerminal } from './initial-session-terminal'

type InitialSessionTerminalAutoCreateState = {
  autoCreatedForWorktree: string | null
  sawSessionTabs: boolean
}

// Reset bookkeeping per workspace so revisits cannot inherit another route’s hydrated state.
export function createInitialSessionAutoCreateState(): InitialSessionTerminalAutoCreateState {
  return { autoCreatedForWorktree: null, sawSessionTabs: false }
}

type InitialSessionTerminalAutoCreateArgs = {
  client: unknown
  newlyCreatedWorkspace: boolean
  connState: string
  terminalsLoaded: boolean
  visibleTabCount: number
  activeHandle: string | null
  createInFlight: boolean
  stateRef: RefObject<InitialSessionTerminalAutoCreateState>
  worktreeId: string
  consumeCreationRoute: () => void
  createTerminal: () => void
}

export function useInitialSessionTerminalAutoCreate(
  args: InitialSessionTerminalAutoCreateArgs
): void {
  const {
    client,
    newlyCreatedWorkspace,
    connState,
    terminalsLoaded,
    visibleTabCount,
    activeHandle,
    createInFlight,
    stateRef,
    worktreeId
  } = args
  // Keep changing route callbacks out of effect dependencies without mutating refs during render.
  const consumeCreationRoute = useEffectEvent(args.consumeCreationRoute)
  const createTerminal = useEffectEvent(args.createTerminal)

  useEffect(() => {
    if (
      newlyCreatedWorkspace &&
      client &&
      connState === 'connected' &&
      terminalsLoaded &&
      (visibleTabCount > 0 || activeHandle !== null)
    ) {
      consumeCreationRoute()
    }
    if (
      !client ||
      !shouldAutoCreateInitialSessionTerminal({
        newlyCreatedWorkspace,
        connected: connState === 'connected',
        tabsLoaded: terminalsLoaded,
        visibleTabCount,
        hasActiveTerminalHandle: activeHandle !== null,
        createInFlight,
        sawSessionTabs: stateRef.current.sawSessionTabs,
        autoCreatedForWorktree: stateRef.current.autoCreatedForWorktree === worktreeId
      })
    ) {
      return
    }
    stateRef.current.autoCreatedForWorktree = worktreeId
    createTerminal()
  }, [
    activeHandle,
    client,
    connState,
    createInFlight,
    newlyCreatedWorkspace,
    stateRef,
    terminalsLoaded,
    visibleTabCount,
    worktreeId
  ])
}

// Key hydration by workspace so route reuse cannot expose the previous workspace’s ready state.
export function useWorktreeSessionTabsLoaded(
  worktreeId: string
): readonly [boolean, (loaded: boolean) => void] {
  const [loadedForWorktree, setLoaded] = useReducer(
    (_current: string | null, loaded: boolean) => (loaded ? worktreeId : null),
    null
  )
  return [loadedForWorktree === worktreeId, setLoaded]
}
