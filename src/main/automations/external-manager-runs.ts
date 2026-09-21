import type {
  ExternalAutomationProvider,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage
} from '../../shared/automations-types'
import {
  EXTERNAL_AUTOMATION_SCOPE_CODES,
  ExternalAutomationScopeError
} from '../../shared/external-automation-scope'
import { mapHermesJobs } from './external-job-mappers'
import { assertExternalAutomationJobId } from './external-manager-job-id'
import {
  isRelayMethodNotFoundError,
  requireExternalAutomationMultiplexer
} from './external-manager-relay'
import { readHermesCronOutputRunsPage } from './hermes-cron-output'

/**
 * Runs the relay's paged runs call, translating "no such method" into a code the
 * renderer can act on.
 *
 * The structured code exists only here: Electron IPC preserves nothing but the
 * message, so a renderer that re-derived this from the host's prose would be
 * guessing. Translating at the boundary that can still see the code is what lets
 * the caller fall back to job-carried runs without matching free text.
 */
async function requestRemoteExternalRuns(
  connectionId: string,
  params: { provider: ExternalAutomationProvider; jobId: string; page: number; pageSize: number }
): Promise<{ total?: number; runs?: unknown[] }> {
  try {
    return (await requireExternalAutomationMultiplexer(connectionId).request(
      'externalAutomations.runs',
      params
    )) as {
      total?: number
      runs?: unknown[]
    }
  } catch (error) {
    if (isRelayMethodNotFoundError(error)) {
      throw new ExternalAutomationScopeError(EXTERNAL_AUTOMATION_SCOPE_CODES.runsUnsupported)
    }
    throw error
  }
}

export async function listExternalAutomationRuns(
  input: ExternalAutomationRunsInput
): Promise<ExternalAutomationRunsPage> {
  assertExternalAutomationJobId(input.jobId)
  const page = Number.isFinite(input.page) ? Math.max(1, Math.floor(input.page)) : 1
  const pageSize = Number.isFinite(input.pageSize)
    ? Math.min(100, Math.max(1, Math.floor(input.pageSize)))
    : 25
  const identity = {
    managerId: input.managerId,
    provider: input.provider,
    target: input.target,
    jobId: input.jobId,
    page,
    pageSize
  }
  if (input.provider !== 'hermes') {
    return { ...identity, total: 0, runs: [] }
  }
  const result =
    input.target.type === 'local'
      ? await readHermesCronOutputRunsPage(input.jobId, { page, pageSize })
      : await requestRemoteExternalRuns(input.target.connectionId, {
          provider: input.provider,
          jobId: input.jobId,
          page,
          pageSize
        })
  return {
    ...identity,
    total: typeof result.total === 'number' && Number.isFinite(result.total) ? result.total : 0,
    runs:
      mapHermesJobs(input.managerId, [{ id: input.jobId, runs: result.runs ?? [] }])[0]?.runs ?? []
  }
}
