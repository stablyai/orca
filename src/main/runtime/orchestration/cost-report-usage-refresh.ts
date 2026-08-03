import type {
  OrchestrationReportProvider,
  OrchestrationReportUsageSnapshot
} from '../../../shared/orchestration-cost-report'

export type OrchestrationReportUsageStore = {
  getScanState(): {
    enabled: boolean
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
  refresh(force?: boolean): Promise<unknown>
  getOrchestrationReportUsage(limit: number): OrchestrationReportUsageSnapshot
}

type UsageStoreEntry = {
  provider: OrchestrationReportProvider
  store: OrchestrationReportUsageStore | null | undefined
}

export const ORCHESTRATION_REPORT_USAGE_REFRESH_TIMEOUT_MS = 8_000

function refreshFailure(provider: OrchestrationReportProvider): OrchestrationReportUsageSnapshot {
  const label =
    provider === 'opencode' ? 'OpenCode' : `${provider[0].toUpperCase()}${provider.slice(1)}`
  return {
    provider,
    status: 'error',
    lastScanCompletedAt: null,
    message: `${label} usage refresh failed.`,
    limitations: [],
    sessions: [],
    truncated: false
  }
}

async function refreshWithTimeout(
  store: OrchestrationReportUsageStore,
  force: boolean,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      store.refresh(force),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Usage refresh timed out.')), timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export async function refreshOrchestrationReportUsageSnapshots(
  entries: readonly UsageStoreEntry[],
  options: {
    completedAt: number | null
    limit: number
    timeoutMs?: number
  }
): Promise<OrchestrationReportUsageSnapshot[]> {
  const availableEntries = entries.filter(
    (entry): entry is UsageStoreEntry & { store: OrchestrationReportUsageStore } =>
      entry.store != null
  )
  const timeoutMs = options.timeoutMs ?? ORCHESTRATION_REPORT_USAGE_REFRESH_TIMEOUT_MS
  const refreshes = await Promise.allSettled(
    availableEntries.map(async ({ store }) => {
      const scanState = store.getScanState()
      const force =
        scanState.enabled &&
        options.completedAt !== null &&
        (scanState.lastScanCompletedAt === null ||
          scanState.lastScanCompletedAt < options.completedAt)
      await refreshWithTimeout(store, force, timeoutMs)
    })
  )

  return availableEntries.map(({ provider, store }, index) => {
    if (refreshes[index].status === 'rejected') {
      return refreshFailure(provider)
    }
    try {
      return store.getOrchestrationReportUsage(options.limit)
    } catch {
      return refreshFailure(provider)
    }
  })
}
