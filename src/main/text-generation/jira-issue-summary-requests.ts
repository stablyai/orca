import os from 'node:os'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/commit-message-host-key'
import type {
  JiraIssueSummaryGenerationRequest,
  JiraIssueSummaryGenerationCancellation,
  JiraIssueSummaryGenerationResult
} from '../../shared/jira-issue-summary-generation'
import { getStatus } from '../jira/client'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from './commit-message-agent-environment'
import { resolveTextGenerationParams } from './commit-message-text-generation'
import {
  cancelGenerateJiraIssueSummaryLocal,
  generateJiraIssueSummaryFromContext
} from './jira-issue-summary-text-generation'

export type JiraIssueSummaryGenerationHost = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0]
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
}

type ActiveRequest = JiraIssueSummaryGenerationCancellation & { owner: string }
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
    return { success: false, error: 'Description is required.' }
  }
  if (!getStatus().sites?.some((site) => site.id === args.siteId)) {
    return { success: false, error: 'Reconnect the selected Jira account on this host.' }
  }
  if (signal?.aborted) {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }
  if (activeRequest) {
    if (
      activeRequest.owner !== owner ||
      activeRequest.siteId !== args.siteId ||
      activeRequest.draftId !== args.draftId
    ) {
      return { success: false, error: 'A Jira title is already being generated in another draft.' }
    }
    cancelJiraIssueSummaryRequest(owner, activeRequest)
  }
  const request = { owner, siteId: args.siteId, draftId: args.draftId, requestId: args.requestId }
  activeRequest = request
  const cancel = (): void => cancelJiraIssueSummaryRequest(owner, request)
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const resolved = resolveTextGenerationParams(
      host.getSettings(),
      LOCAL_COMMIT_MESSAGE_HOST_KEY,
      'branchName',
      null
    )
    if (!resolved.ok) {
      return { success: false, error: resolved.error }
    }
    const localEnv = await prepareLocalCommitMessageAgentEnv(
      resolved.params.agentId,
      host.getAgentEnvironment()
    )
    if (activeRequest !== request) {
      return { success: false, error: 'Generation canceled.', canceled: true }
    }
    if (!localEnv.ok) {
      return { success: false, error: localEnv.error }
    }
    if (!getStatus().sites?.some((site) => site.id === args.siteId)) {
      return { success: false, error: 'Reconnect the selected Jira account on this host.' }
    }
    const result = await generateJiraIssueSummaryFromContext(args, resolved.params, {
      kind: 'local',
      cwd,
      ...(localEnv.env ? { env: localEnv.env } : {})
    })
    return activeRequest === request
      ? result
      : { success: false, error: 'Generation canceled.', canceled: true }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (activeRequest === request) {
      activeRequest = undefined
    }
  }
}
