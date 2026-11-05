import os from 'node:os'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import type {
  JiraIssueSummaryGenerationRequest,
  JiraIssueSummaryGenerationCancellation,
  JiraIssueSummaryGenerationResult
} from '../../shared/jira/jira-issue-summary-generation'
import {
  textGenerationFailure,
  textGenerationFailureCodeFields
} from '../../shared/text-generation-failure-copy'
import { getStatus } from '../jira/client'
import type { CommitMessageAgentEnvironmentResolvers } from './commit-message-agent-environment'
import { resolveGenerationTargetResult } from '../agent-hooks/first-work-generation-target'
import type { CommitMessageGenerationTarget } from './source-control-text-generation-types'
import { resolveTextGenerationParams } from './commit-message-text-generation'
import { createResolvedTextGenerationParamsFence } from './text-generation-settings-fence'
import { localGenerationCanceledResult } from './source-control-generation-lanes'
import {
  cancelGenerateJiraIssueSummaryLocal,
  generateJiraIssueSummaryFromContext
} from './jira-issue-summary-text-generation'

export type JiraIssueSummaryGenerationHost = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0]
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
}

type ActiveRequest = JiraIssueSummaryGenerationCancellation & { owner: string; cancel?: () => void }
// IPC and RPC share the same process lane, including while preparing account credentials.
let activeRequest: ActiveRequest | undefined
const cwd = os.homedir()

export function cancelJiraIssueSummaryRequest(
  owner: string,
  args: JiraIssueSummaryGenerationCancellation
): void {
  if (
    activeRequest?.owner === owner &&
    activeRequest.siteId === args.siteId &&
    activeRequest.draftId === args.draftId &&
    activeRequest.requestId === args.requestId
  ) {
    activeRequest.cancel?.()
    activeRequest = undefined
    cancelGenerateJiraIssueSummaryLocal(cwd)
  }
}

export async function generateJiraIssueSummaryRequest(
  host: JiraIssueSummaryGenerationHost,
  owner: string,
  args: JiraIssueSummaryGenerationRequest,
  signal?: AbortSignal
): Promise<JiraIssueSummaryGenerationResult> {
  if (!args.description.trim()) {
    return {
      success: false,
      ...textGenerationFailure('jiraDescriptionRequired')
    }
  }
  if (!getStatus().sites?.some((site) => site.id === args.siteId)) {
    return {
      success: false,
      ...textGenerationFailure('jiraAccountDisconnected')
    }
  }
  if (signal?.aborted) {
    return localGenerationCanceledResult()
  }
  if (activeRequest) {
    if (
      activeRequest.owner !== owner ||
      activeRequest.siteId !== args.siteId ||
      activeRequest.draftId !== args.draftId
    ) {
      return {
        success: false,
        ...textGenerationFailure('jiraSummaryBusyInOtherDraft')
      }
    }
    cancelJiraIssueSummaryRequest(owner, activeRequest)
  }
  const request: ActiveRequest = {
    owner,
    siteId: args.siteId,
    draftId: args.draftId,
    requestId: args.requestId
  }
  activeRequest = request
  const cancel = (): void => cancelJiraIssueSummaryRequest(owner, request)
  signal?.addEventListener('abort', cancel, { once: true })
  let target: CommitMessageGenerationTarget | null = null
  const siteConnected = () => getStatus().sites?.some((site) => site.id === args.siteId) === true
  const stopped = (): JiraIssueSummaryGenerationResult =>
    siteConnected()
      ? localGenerationCanceledResult()
      : { success: false, ...textGenerationFailure('jiraAccountDisconnected') }
  try {
    const settings = host.getSettings()
    const resolved = resolveTextGenerationParams(
      settings,
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    if (!resolved.ok) {
      return { success: false, error: resolved.error, ...textGenerationFailureCodeFields(resolved) }
    }
    const settingsCurrent = createResolvedTextGenerationParamsFence(
      () => host.getSettings(),
      { settings, resolved },
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    const current = () => activeRequest === request && !signal?.aborted && settingsCurrent()
    const resolvedTarget = await resolveGenerationTargetResult(
      cwd,
      resolved.params.agentId,
      {
        getAgentEnvResolvers: () => host.getAgentEnvironment()
      },
      {
        operation: 'jira-issue-summary',
        params: resolved.params,
        current,
        validate: async () => siteConnected(),
        ownerId: JSON.stringify([owner, args.siteId, args.draftId])
      }
    )
    target = resolvedTarget.ok ? resolvedTarget.target : null
    if (!current()) {
      return localGenerationCanceledResult()
    }
    if (!resolvedTarget.ok) {
      return { success: false, error: resolvedTarget.error }
    }
    if (!target || target.kind !== 'local') {
      return { success: false, error: 'Could not prepare the generation environment.' }
    }
    if (!siteConnected()) {
      return stopped()
    }
    const budget = target.request
    // Without failover, Stop keeps the pre-existing lane cancellation in cancelJiraIssueSummaryRequest.
    request.cancel = budget?.cancel
    if (budget && !(await budget.validate())) {
      return stopped()
    }
    const result = await generateJiraIssueSummaryFromContext(args, resolved.params, target)
    if (activeRequest !== request) {
      return localGenerationCanceledResult()
    }
    if ((result.success || result.canceled) && budget && !(await budget.validate())) {
      return stopped()
    }
    return result
  } finally {
    if (target?.kind === 'local') {
      target.request?.finish()
    }
    signal?.removeEventListener('abort', cancel)
    if (activeRequest === request) {
      activeRequest = undefined
    }
  }
}
