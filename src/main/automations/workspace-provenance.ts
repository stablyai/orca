import { z } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type {
  AutomationWorkspaceProvenance,
  AutomationWorkspaceProvenanceRequest,
  Repo
} from '../../shared/types'
import {
  beginAutomationDispatchTokenUse,
  finishAutomationDispatchTokenUse,
  releaseAutomationDispatchTokenUse
} from './dispatch-tokens'

export type AutomationWorkspaceProvenanceAuthority = {
  showAutomation: (id: string) => Automation
  listAutomationRuns: (automationId?: string) => AutomationRun[]
}

export function invalidAutomationProvenanceRequest(): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ['automationProvenanceRequest'],
      message: 'Invalid automation provenance request'
    }
  ])
}

function repoSelectorMatchesAutomation(selector: string, repoId: string): boolean {
  return selector === repoId || selector === `id:${repoId}`
}

export function resolveAutomationWorkspaceProvenance(args: {
  authority: AutomationWorkspaceProvenanceAuthority
  repoSelector: string
  repo: Repo
  request: AutomationWorkspaceProvenanceRequest | undefined
}): AutomationWorkspaceProvenance | undefined {
  const { authority, repoSelector, repo, request } = args
  if (!request) {
    return undefined
  }

  let automation: Automation
  try {
    automation = authority.showAutomation(request.automationId)
  } catch {
    invalidAutomationProvenanceRequest()
  }
  const run = authority
    .listAutomationRuns(request.automationId)
    .find((entry) => entry.id === request.automationRunId)
  const expectedRepoId = run?.runContext?.repoId ?? getAutomationRunRepoId(automation)

  if (
    !run ||
    run.automationId !== automation.id ||
    run.status !== 'dispatching' ||
    run.workspaceId !== null ||
    automation.workspaceMode !== 'new_per_run' ||
    !repoSelectorMatchesAutomation(repoSelector, expectedRepoId)
  ) {
    invalidAutomationProvenanceRequest()
  }
  if (
    !beginAutomationDispatchTokenUse({
      automationId: request.automationId,
      runId: request.automationRunId,
      token: request.dispatchToken,
      reservationId: request.createRequestId
    })
  ) {
    invalidAutomationProvenanceRequest()
  }

  return buildAutomationWorkspaceProvenance(automation, run, repo)
}

export function releaseAutomationWorkspaceProvenanceRequest(
  request: AutomationWorkspaceProvenanceRequest | undefined
): void {
  if (!request) {
    return
  }
  releaseAutomationDispatchTokenUse({
    token: request.dispatchToken,
    reservationId: request.createRequestId
  })
}

export function finishAutomationWorkspaceProvenanceRequest(
  request: AutomationWorkspaceProvenanceRequest | undefined
): void {
  if (!request) {
    return
  }
  finishAutomationDispatchTokenUse({
    token: request.dispatchToken,
    reservationId: request.createRequestId
  })
}
