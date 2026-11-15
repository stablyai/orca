import { OrcaWatchActionSpike } from '../../modules/orca-watch-action-spike/src/index'
import {
  hostAnsweredStatusProbe,
  hostStatusProbe
} from '../transport/connection/host-status-probe-operations'
import { openHostLogicalClient } from '../transport/connection/host-logical-client'
import { loadHostCatalog } from '../transport/hosts/host-store'
import type { WatchActionSpikeStep } from './watch-action-spike-results'

const HOST_ANSWER_TIMEOUT_MS = 20_000

export type WatchActionSpikeRoundTrip = {
  ok: boolean
  failedStep?: string
  path?: string
  steps: WatchActionSpikeStep[]
  log: string[]
}

// The production path a tap would take: keychain → paired E2EE client → one host answer.
export async function runWatchActionSpikeRoundTrip(
  hostId: string
): Promise<WatchActionSpikeRoundTrip> {
  const startedAt = Date.now()
  const steps: WatchActionSpikeStep[] = []
  const log: string[] = []
  const mark = (step: string, detail?: string) =>
    steps.push({ step, ms: Date.now() - startedAt, ...(detail !== undefined ? { detail } : {}) })
  const fail = (failedStep: string, detail: string): WatchActionSpikeRoundTrip => {
    mark(failedStep, detail)
    return { ok: false, failedStep, steps, log }
  }

  const protectedData = await OrcaWatchActionSpike?.isProtectedDataAvailable().catch(() => null)
  mark('protected-data', String(protectedData ?? 'unknown'))

  let entry
  try {
    entry = (await loadHostCatalog()).find((candidate) => candidate.id === hostId)
  } catch (error) {
    return fail('host-catalog', describe(error))
  }
  if (!entry) {
    return fail('host-catalog', 'host not paired')
  }
  mark('keychain', entry.credentialStatus)
  if (!entry.profile) {
    return fail('keychain', `credentials ${entry.credentialStatus}`)
  }

  const client = openHostLogicalClient(entry.profile, (logEntry) => {
    log.push(`+${Date.now() - startedAt}ms ${logEntry.code ?? logEntry.level} ${logEntry.message}`)
  })
  try {
    const reply = await hostStatusProbe.request(client, undefined, {
      timeoutMs: HOST_ANSWER_TIMEOUT_MS,
      budgetSpansConnect: true
    })
    if (!hostAnsweredStatusProbe(reply)) {
      return fail('host-answer', 'host refused status.get')
    }
    const path = client.getActivePath?.()
    mark('host-answer', path)
    return { ok: true, ...(path ? { path } : {}), steps, log }
  } catch (error) {
    return fail('host-answer', describe(error))
  } finally {
    client.close()
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
