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
  /** Cached repos when this client already answered, otherwise one fetch. */
  ensureLoaded: () => Promise<Repo[]>
  /** Discards the cache so an explicit refresh re-reads the host. */
  reload: () => Promise<Repo[]>
}

/** Binds the repo list to `clientKey`. Pass `fetchRepos: null` while there is no
 *  usable connection; the resource then stays idle instead of caching an empty
 *  answer that a later client would inherit. */
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

  // Why: discarding the previous client's list has to happen before anything can
  // read it, and Expo reuses this screen for the next host. A state update during
  // render is the supported way to do that; a ref write here is not, because a
  // concurrent render React abandons would still have mutated it.
  const [boundKey, setBoundKey] = useState(clientKey)
  if (boundKey !== clientKey) {
    setBoundKey(clientKey)
    dispatch({ type: 'reset' })
  }

  // Why: the async request guard reads these, so they are written in the commit
  // phase - the earliest point a render is known to have survived.
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
    // Retires every request issued for the previous client.
    requestIdRef.current += 1
  }, [clientKey])

  // Why: consumers hold these in dependency arrays, so they must never change
  // identity. Everything they read lives in refs, so they never need to.
  const reload = useCallback(async (): Promise<Repo[]> => {
    const fetchNow = fetchRef.current
    if (!fetchNow) {
      return []
    }
    if (inFlightRef.current) {
      return inFlightRef.current
    }
    // Why: only the request issued for the currently bound client may commit.
    // A slow response from the previous host would otherwise land afterwards
    // and pin its repos as this host's authoritative list.
    const requestKey = boundKeyRef.current
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    const request = (async (): Promise<Repo[]> => {
      dispatch({ type: 'requested' })
      try {
        const repos = await fetchNow()
        // Why: A -> B -> A reuses the same client, so matching the key alone
        // would let a stale request for A overwrite a newer result for A.
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

  // Why: within one event React has not rendered the `requested` dispatch yet, so
  // the status still reads `loaded`. Join the in-flight request instead of
  // handing back the list it is about to replace.
  const ensureLoaded = useCallback(
    (): Promise<Repo[]> =>
      inFlightRef.current ??
      (needsHostRepoListFetch(stateRef.current) ? reload() : Promise.resolve(reposRef.current)),
    [reload]
  )

  return useMemo(() => ({ state, ensureLoaded, reload }), [ensureLoaded, reload, state])
}
