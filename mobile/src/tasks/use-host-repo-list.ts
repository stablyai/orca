import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  hostRepoListReducer,
  initialHostRepoList,
  needsHostRepoListFetch,
  type HostRepoListState
} from './host-repo-list'

export type HostRepoListResource<Repo> = {
  state: HostRepoListState<Repo>
  ensureLoaded: () => Promise<Repo[]>
  reload: () => Promise<Repo[]>
  current: () => Repo[]
}

// No usable connection stays idle; caching an empty reply would poison the next client’s list.
export function useHostRepoList<Repo>(
  clientKey: unknown,
  fetchRepos: (() => Promise<Repo[]>) | null
): HostRepoListResource<Repo> {
  const [state, dispatch] = useReducer(
    hostRepoListReducer<Repo>,
    undefined,
    initialHostRepoList<Repo>
  )
  const boundKeyRef = useRef(clientKey)
  const reposRef = useRef<Repo[]>([])
  const inFlightRef = useRef<Promise<Repo[]> | null>(null)
  const requestIdRef = useRef(0)
  const fetchRef = useRef(fetchRepos)
  const stateRef = useRef(state)

  // Reset during render before reused screens can read another client’s list; refs would leak abandoned concurrent renders.
  const [boundKey, setBoundKey] = useState(clientKey)
  if (boundKey !== clientKey) {
    setBoundKey(clientKey)
    dispatch({ type: 'reset' })
  }

  // Write async request guards only at commit, after the render is known to survive.
  useEffect(() => {
    fetchRef.current = fetchRepos
    stateRef.current = state
  })

  useLayoutEffect(() => {
    if (boundKeyRef.current === clientKey) {
      return
    }
    boundKeyRef.current = clientKey
    reposRef.current = []
    inFlightRef.current = null
    requestIdRef.current += 1
  }, [clientKey])

  // Consumers depend on callback identity; read mutable inputs through refs.
  const reload = useCallback(async (): Promise<Repo[]> => {
    const fetchNow = fetchRef.current
    if (!fetchNow) {
      return []
    }
    if (inFlightRef.current) {
      return inFlightRef.current
    }
    // Only requests for the currently bound client may publish; old-host replies can arrive late.
    const requestKey = boundKeyRef.current
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const request = (async (): Promise<Repo[]> => {
      dispatch({ type: 'requested' })
      try {
        const repos = await fetchNow()
        // Client-key equality alone cannot fence stale A replies after A → B → A navigation.
        if (boundKeyRef.current !== requestKey || requestIdRef.current !== requestId) {
          return []
        }
        reposRef.current = repos
        dispatch({ type: 'resolved', repos })
        return repos
      } catch (err) {
        if (boundKeyRef.current === requestKey && requestIdRef.current === requestId) {
          dispatch({
            type: 'failed',
            error: err instanceof Error ? err.message : 'Unknown error'
          })
        }
        throw err
      } finally {
        if (requestIdRef.current === requestId) {
          inFlightRef.current = null
        }
      }
    })()
    inFlightRef.current = request
    return request
  }, [])

  // Join the replacement request before requested state commits; loaded still names the old list in this event.
  const ensureLoaded = useCallback(
    (): Promise<Repo[]> =>
      inFlightRef.current ??
      (needsHostRepoListFetch(stateRef.current) ? reload() : Promise.resolve(reposRef.current)),
    [reload]
  )

  const current = useCallback((): Repo[] => reposRef.current, [])

  return useMemo(
    () => ({ state, ensureLoaded, reload, current }),
    [current, ensureLoaded, reload, state]
  )
}
