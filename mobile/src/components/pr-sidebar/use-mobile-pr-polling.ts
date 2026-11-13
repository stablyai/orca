import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  ChecksDetailPollingPolicy,
  nextChecksPollBackoffMs
} from '../../../../src/shared/github/checks/checks-detail-polling-policy'
import type { PRCheckDetail } from '../../../../src/shared/github/checks/check-types'
import type { PRInfo } from '../../../../src/shared/github/pull-requests/pull-request-types'
import { useHostQuery } from '../../query/host-query'
import {
  NO_BRANCH,
  NO_CHECKS,
  NO_PR,
  prBranchReviewQuery,
  prChecksQuery,
  prDetailsQuery,
  type PrQueryScope
} from '../../source-control/review/mobile-pr-queries'
import {
  prSidebarResourceKey,
  type PrSidebarState
} from '../../source-control/review/mobile-pr-sidebar-state'

/** What is on screen: nothing to keep fresh, the PR and its checks, or its comments too. */
export type PrTabLive = false | 'checks' | 'details'

type Input = {
  queries: PrQueryScope | null
  state: PrSidebarState
  live: PrTabLive
  connected: boolean
}

type Cadence = {
  resource: string | null
  // The last checks read each step accounted for, so a re-render never counts one twice.
  dataAt: number
  errorAt: number
  backoffMs: number
  signature: string | null
  checks: readonly PRCheckDetail[] | null
  failed: boolean
}

const FIRST_BACKOFF_MS = 60_000
const NO_HOST = { hostId: '', client: null }
const NO_TARGET = { exec: 'local' as const }

function freshCadence(resource: string | null): Cadence {
  return {
    resource,
    dataAt: 0,
    errorAt: 0,
    backoffMs: FIRST_BACKOFF_MS,
    signature: null,
    checks: null,
    failed: false
  }
}

// Every checks read that lands feeds the backoff: unchanged checks slow it, changes reset it, a failure fails it.
function stepCadence(
  cadence: Cadence,
  read: { data: PRCheckDetail[] | undefined; dataAt: number; errorAt: number }
): Cadence {
  if (read.errorAt > cadence.errorAt && read.errorAt >= read.dataAt) {
    return {
      ...cadence,
      errorAt: read.errorAt,
      failed: true,
      backoffMs: nextChecksPollBackoffMs(cadence.backoffMs, 'failed')
    }
  }
  if (read.data && read.dataAt > cadence.dataAt) {
    const signature = new ChecksDetailPollingPolicy().accept(read.data)
    return {
      ...cadence,
      dataAt: read.dataAt,
      failed: false,
      checks: read.data,
      signature,
      backoffMs: nextChecksPollBackoffMs(
        cadence.backoffMs,
        signature === cadence.signature ? 'unchanged' : 'changed'
      )
    }
  }
  return cadence
}

function pollDelayMs(
  cadence: Cadence,
  state: PRInfo['state'],
  checksStatus: PRInfo['checksStatus'] | undefined
): number | null {
  const policy = new ChecksDetailPollingPolicy()
  if (cadence.failed) {
    policy.fail()
  } else if (cadence.checks) {
    policy.accept(cadence.checks)
  }
  return policy.delayMs(state, checksStatus, cadence.backoffMs)
}

// Desktop's checks-panel cadence (shared policy): 1 min while open, backing off to 2 min when nothing
// changes and up to 15 min on failures, stopping once a merged PR's checks settle. It runs only while
// the PR is on screen, its route is focused, the host is connected and the app is in the foreground
// (TanStack's focus manager pauses intervals in the background). Elsewhere details follow the PR's updatedAt.
export function useMobilePrPolling({ queries, state, live, connected }: Input): {
  /** Polling is running for an open PR, so the screen can say "Live" instead of offering Refresh. */
  polling: boolean
} {
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const pr = state.kind === 'ready' ? state.data.pr : null
  const running = live !== false && focused && connected && pr !== null && queries !== null
  const host = queries?.host ?? NO_HOST
  const target = queries?.target ?? NO_TARGET

  // Each PR incarnation starts its own cadence, so a read for the last one cannot steer this one's.
  const resource = pr ? prSidebarResourceKey(pr) : null
  const [cadence, setCadence] = useState(() => freshCadence(resource))
  const current = cadence.resource === resource ? cadence : freshCadence(resource)
  const prState = pr?.state
  const checksStatus = pr?.checksStatus
  const delay = useMemo(
    () => (running && prState ? pollDelayMs(current, prState, checksStatus) : null),
    [running, current, prState, checksStatus]
  )
  const refetchInterval = delay ?? false
  useHostQuery(prBranchReviewQuery, host, target, queries?.branchInput ?? NO_BRANCH, {
    enabled: running && queries?.branchInput != null,
    refetchInterval
  })
  const checksRead = useHostQuery(prChecksQuery, host, target, queries?.checksInput ?? NO_CHECKS, {
    enabled: running && queries?.checksInput != null,
    refetchInterval
  })
  // Thread resolution and comment edits leave the PR's updatedAt alone, so open Comments polls its details too.
  const pollDetails = running && live === 'details' && queries?.detailsInput != null
  useHostQuery(prDetailsQuery, host, target, queries?.detailsInput ?? NO_PR, {
    enabled: pollDetails,
    refetchInterval: pollDetails ? refetchInterval : false
  })
  const next = stepCadence(current, {
    data: checksRead.data,
    dataAt: checksRead.dataUpdatedAt,
    errorAt: checksRead.errorUpdatedAt
  })
  if (next !== cadence) {
    setCadence(next)
  }

  return { polling: pr !== null && running && (pr.state === 'open' || pr.state === 'draft') }
}
