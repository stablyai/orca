// Track which client answered and whether it was fetched; host switches and unfetched empty arrays otherwise hide Project rows.

export type HostRepoListStatus = 'idle' | 'loading' | 'loaded' | 'error'

export type HostRepoListState<Repo> = {
  status: HostRepoListStatus
  // Retain rows through reload; reset only on identity change.
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

// Do not show no repos until a fetch has settled.
export function hasSettledHostRepoList(state: HostRepoListState<unknown>): boolean {
  return state.status === 'loaded' || state.status === 'error'
}

// An in-flight request is not fetched; callers needing current repos must await a request.
export function needsHostRepoListFetch(state: HostRepoListState<unknown>): boolean {
  return state.status !== 'loaded'
}
