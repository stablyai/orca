import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/AccountUsage'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import type { RpcClient } from '../transport/rpc-client'
import { sendSingleFlightRequest } from '../transport/request-single-flight'

type HomeTaskSettings = {
  visibleTaskProviders?: unknown
}

type HomePreflightStatus = {
  glab?: { installed?: boolean }
}

type HomeLinearStatus = {
  connected?: boolean
}

export type HomeStatsSetter = (
  updater: (previous: Record<string, HomeStatsSummary>) => Record<string, HomeStatsSummary>
) => void

export type HomeAccountsSetter = (
  updater: (previous: Record<string, AccountsSnapshot>) => Record<string, AccountsSnapshot>
) => void

export type HomeTaskProvidersSetter = (
  updater: (previous: Record<string, TaskProvider[]>) => Record<string, TaskProvider[]>
) => void

export function fetchMobileHomeStats(
  client: RpcClient,
  hostId: string,
  setStats: HomeStatsSetter,
  disposed: () => boolean
): void {
  sendSingleFlightRequest(client, hostId, 'stats.summary')
    .then((response) => {
      if (!disposed() && response.ok) {
        setStats((previous) => ({
          ...previous,
          [hostId]: response.result as HomeStatsSummary
        }))
      }
    })
    .catch(() => {})
}

export function fetchMobileHomeAccounts(
  client: RpcClient,
  hostId: string,
  setSnapshots: HomeAccountsSetter,
  disposed: () => boolean
): void {
  sendSingleFlightRequest(client, hostId, 'accounts.list')
    .then((response) => {
      if (!disposed() && response.ok) {
        const snapshot = decodeAccountsSnapshot(response.result)
        setSnapshots((previous) => ({ ...previous, [hostId]: snapshot }))
      }
    })
    .catch(() => {})
}

export function fetchMobileHomeTaskProviders(
  client: RpcClient,
  hostId: string,
  setProviders: HomeTaskProvidersSetter,
  disposed: () => boolean
): void {
  Promise.all([
    sendSingleFlightRequest(client, hostId, 'settings.get'),
    sendSingleFlightRequest(client, hostId, 'preflight.check'),
    sendSingleFlightRequest(client, hostId, 'linear.status')
  ])
    .then(([settingsResponse, preflightResponse, linearResponse]) => {
      if (disposed()) {
        return
      }
      const settings = settingsResponse.ok
        ? (((settingsResponse.result as { settings?: HomeTaskSettings }).settings ??
            {}) as HomeTaskSettings)
        : {}
      const preflight = preflightResponse.ok
        ? (preflightResponse.result as HomePreflightStatus)
        : null
      const linear = linearResponse.ok ? (linearResponse.result as HomeLinearStatus) : null
      const providers = filterAvailableTaskProviders(
        normalizeVisibleTaskProviders(settings.visibleTaskProviders),
        {
          gitlabInstalled: preflight?.glab?.installed === true,
          linearConnected: linear?.connected === true
        }
      )
      setProviders((previous) => ({ ...previous, [hostId]: providers }))
    })
    .catch(() => {
      if (!disposed()) {
        setProviders((previous) =>
          previous[hostId] ? previous : { ...previous, [hostId]: ['github'] }
        )
      }
    })
}
