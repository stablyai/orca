import { githubRepoIdentityKey } from '../../../../src/shared/github/repository-identity-key'
import { useEffect, useLayoutEffect, useState } from 'react'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../../src/shared/github/pull-request-types'
import type { RpcClient } from '../../transport/rpc-client'
import type { ConnectionState } from '../../transport/types'
import { fetchAssignableUsers } from '../../session/github-pr-rpc'

export type ReviewerPeople = {
  // Undefined until this visit accepts a reply; [] is an accepted empty list.
  users: GitHubAssignableUser[] | undefined
  error: { message: string | null } | null
  state: ConnectionState
}

// One open sheet request for one client/worktree/repository; closing, retargeting or reopening starts a new visit.
type PeopleVisit = {
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubOwnerRepo | null
  targetKey: string | null
  request: unknown
  live: boolean
  attempt: number
  observed: { state: ConnectionState; generation: number | undefined } | null
  latest: ReviewerPeople
}

type Target = {
  client: RpcClient | null
  worktreeId: string
  prRepo: GitHubOwnerRepo | null
  /** The open sheet request this visit serves, or null once it closed or its PR departed. */
  request: unknown
}

function createPeopleVisit(target: Target): PeopleVisit {
  return {
    ...target,
    targetKey: target.prRepo ? githubRepoIdentityKey(target.prRepo) : null,
    live: false,
    attempt: 0,
    observed: null,
    latest: { users: undefined, error: null, state: target.client?.getState() ?? 'disconnected' }
  }
}

// The candidate list for the reviewers sheet: demanded by the first search of an open visit and kept for that
// visit, read only while connected, with every real state or generation change retiring the attempt in flight.
export function useReviewerPeople(target: Target & { search: boolean }): ReviewerPeople & {
  demanded: boolean
} {
  const targetKey = target.prRepo ? githubRepoIdentityKey(target.prRepo) : null
  const [selection, setSelection] = useState(() => {
    const visit = createPeopleVisit(target)
    return { visit, snapshot: visit.latest, demanded: false }
  })
  let selected = selection
  if (
    selection.visit.client !== target.client ||
    selection.visit.worktreeId !== target.worktreeId ||
    selection.visit.targetKey !== targetKey ||
    selection.visit.request !== target.request
  ) {
    const visit = createPeopleVisit(target)
    selected = { visit, snapshot: visit.latest, demanded: false }
  }
  // Demand starts with the first search of an open visit and stays until the visit ends, even if search clears.
  if (target.search && selected.visit.request !== null && !selected.demanded) {
    selected = { ...selected, demanded: true }
  }
  if (selected !== selection) {
    setSelection(selected)
  }
  const { visit, snapshot, demanded } = selected

  useLayoutEffect(() => {
    visit.live = true
    return () => {
      visit.live = false
      visit.attempt += 1
    }
  }, [visit])

  useEffect(() => {
    const visitClient = visit.client
    if (!demanded || visit.request === null || !visitClient) {
      return
    }
    const publish = (patch: Partial<ReviewerPeople>) => {
      const next = { ...visit.latest, ...patch }
      visit.latest = next
      setSelection((current) =>
        current.visit === visit ? { ...current, snapshot: next } : current
      )
    }
    // Every real state or generation change retires the active attempt before the notification returns;
    // accepted rows stay, and a connected session starts the one attempt allowed to publish.
    const reconcile = (state: ConnectionState) => {
      if (!visit.live) {
        return
      }
      const generation = visitClient.getGeneration?.()
      const observed = visit.observed
      if (observed?.state === state && Object.is(observed.generation, generation)) {
        return
      }
      visit.observed = { state, generation }
      const attempt = ++visit.attempt
      publish({ state, error: null })
      if (state !== 'connected') {
        return
      }
      const owns = () => visit.live && visit.attempt === attempt
      void fetchAssignableUsers(visitClient, visit.worktreeId, visit.prRepo).then(
        (outcome) => {
          if (!owns()) {
            return
          }
          if (outcome.ok) {
            publish({ users: outcome.result, error: null })
          } else if (!visit.latest.users) {
            publish({ error: { message: outcome.error } })
          }
        },
        () => {
          if (owns() && !visit.latest.users) {
            publish({ error: { message: null } })
          }
        }
      )
    }
    const stop = visitClient.onStateChange(reconcile)
    reconcile(visitClient.getState())
    return () => {
      stop()
      // A resubscription of this visit reconciles from scratch rather than matching a retired attempt.
      visit.observed = null
      visit.attempt += 1
    }
  }, [visit, demanded])

  return { ...snapshot, demanded }
}
