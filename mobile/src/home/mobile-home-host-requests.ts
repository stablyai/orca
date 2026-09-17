import { settingsRead } from '../transport/settings-read-operations'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/AccountUsage'
import type { HomeStatsSummary } from '../stats/home-stats-total'
import { taskLinearStatusRead, taskPreflightRead } from '../tasks/mobile-task-runtime-operations'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import type { RpcClient } from '../transport/rpc-client'
import { homeHostAccountsRead, homeHostStatsRead } from './mobile-home-host-operations'

type HomeTaskSettings = {
  visibleTaskProviders?: unknown
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
  homeHostStatsRead
    .requestSingleFlight(client, hostId)
    .then((reply) => {
      const summary = homeHostStatsRead.interpret(reply)
      if (!disposed() && summary.accepted) {
        setStats((previous) => ({
          ...previous,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          [hostId]: summary.value as HomeStatsSummary
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
  homeHostAccountsRead
    .requestSingleFlight(client, hostId)
    .then((reply) => {
      const accounts = homeHostAccountsRead.interpret(reply)
      if (!disposed() && accounts.accepted) {
        const snapshot = decodeAccountsSnapshot(accounts.value)
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
    settingsRead.requestSingleFlight(client, hostId),
    taskPreflightRead.requestSingleFlight(client, hostId),
    taskLinearStatusRead.requestSingleFlight(client, hostId)
  ])
    .then(([settingsResponse, preflightResponse, linearResponse]) => {
      if (disposed()) {
        return
      }
      const settingsResult = settingsRead.interpret(settingsResponse)
      const settings = settingsResult.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          ((settingsResult.value ?? {}) as HomeTaskSettings)
        : {}
      const preflightResult = taskPreflightRead.interpret(preflightResponse)
      const preflight = preflightResult.accepted ? preflightResult.value : null
      const linearResult = taskLinearStatusRead.interpret(linearResponse)
      const linear = linearResult.accepted ? linearResult.value : null
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
