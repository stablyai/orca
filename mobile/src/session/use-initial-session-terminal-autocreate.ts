import { useEffect, useEffectEvent, useReducer, type RefObject } from 'react'
import { shouldAutoCreateInitialSessionTerminal } from './initial-session-terminal'

type InitialSessionTerminalAutoCreateState = {
  autoCreatedForWorktree: string | null
  sawSessionTabs: boolean
}

/**
 * Fresh auto-create bookkeeping. The route must re-create this on every worktree
 * change, or a revisit inherits the previous workspace's `sawSessionTabs`.
 */
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

/**
 * Creates the first terminal of a newly created mobile workspace that hydrates
 * empty, at most once per route. See initial-session-terminal.
 */
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
  // Why: the route re-creates both callbacks every render; useEffectEvent keeps them
  // out of the deps without mutating a ref during render.
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

/**
 * Tracks "tabs hydrated" per worktree so a reused route reports `false` until the
 * new workspace's own snapshot lands, rather than inheriting the old one's.
 */
export function useWorktreeSessionTabsLoaded(
  worktreeId: string
): readonly [boolean, (loaded: boolean) => void] {
  const [loadedForWorktree, setLoaded] = useReducer(
    (_current: string | null, loaded: boolean) => (loaded ? worktreeId : null),
    null
  )
  return [loadedForWorktree === worktreeId, setLoaded]
}
