/** The host repo list as a client-scoped resource.
 *
 * Why this is a state machine rather than a `repos` array plus a "did we fetch
 * it" flag: the Tasks screen is reused across hosts and `forceReconnect` swaps
 * the client underneath it, so a bare array cannot say *which* client answered,
 * and an empty array cannot say whether the host has no repos or was never
 * asked. Both ambiguities silently filtered every GitHub Project row (#12966).
 */

export type HostRepoListStatus = 'idle' | 'loading' | 'loaded' | 'error'

export type HostRepoListState<Repo> = {
  status: HostRepoListStatus
  /** Last successful response. Retained across a reload so refreshing does not
   *  blank the list, and cleared only by `reset`. */
  repos: Repo[]
  error: string
}

export type HostRepoListAction<Repo> =
  | { type: 'reset' }
  | { type: 'requested' }
  | { type: 'resolved'; repos: Repo[] }
  | { type: 'failed'; error: string }

export const IDLE_HOST_REPO_LIST: HostRepoListState<never> = {
  status: 'idle',
  repos: [],
  error: ''
}

export function initialHostRepoList<Repo>(): HostRepoListState<Repo> {
  return IDLE_HOST_REPO_LIST as HostRepoListState<Repo>
}

export function hostRepoListReducer<Repo>(
  state: HostRepoListState<Repo>,
  action: HostRepoListAction<Repo>
): HostRepoListState<Repo> {
  switch (action.type) {
    case 'reset':
      return state.status === 'idle' ? state : initialHostRepoList<Repo>()
    case 'requested':
      return state.status === 'loading' ? state : { ...state, status: 'loading', error: '' }
    case 'resolved':
      return { status: 'loaded', repos: action.repos, error: '' }
    case 'failed':
      return { ...state, status: 'error', error: action.error }
  }
}

/** Whether a fetch has finished, successfully or not. Callers gate their empty
 *  state on this: "no repos yet" must not render as "this host has no repos". */
export function hasSettledHostRepoList(state: HostRepoListState<unknown>): boolean {
  return state.status === 'loaded' || state.status === 'error'
}

/** Whether `loadTasks` still needs to fetch before it can trust `repos`. An
 *  in-flight request does not count as fetched, so a caller that needs the list
 *  now awaits its own request rather than reading a stale array. */
export function needsHostRepoListFetch(state: HostRepoListState<unknown>): boolean {
  return state.status !== 'loaded'
}
