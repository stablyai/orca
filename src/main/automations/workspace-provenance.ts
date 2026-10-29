import { z } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import { getAutomationRunRepoId } from '../../shared/automation-run-identity'
import { buildAutomationWorkspaceProvenance } from '../../shared/automation-workspace-provenance'
import type { Repo } from '../../shared/repo-types'
import type {
  AutomationWorkspaceProvenance,
  AutomationWorkspaceProvenanceRequest
} from '../../shared/worktree/types'
import { ClientAutomationWorkspaceProvenance } from '../../shared/rpc-contract/worktree-params'
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

/** This host does not hold the automation, or keeps no automations at all. */
function isUnownedAutomationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Automation not found') || error.message === 'runtime_unavailable')
  )
}

function repoSelectorMatchesAutomation(selector: string, repoId: string): boolean {
  return selector === repoId || selector === `id:${repoId}`
}

export function resolveAutomationWorkspaceProvenance(args: {
  authority: AutomationWorkspaceProvenanceAuthority
  repoSelector: string
  repo: Repo
  request: AutomationWorkspaceProvenanceRequest | undefined
  /** A runtime host only verifies its own automations; another owner's token is unverifiable here. */
  ignoreUnknownAutomation?: boolean
}): AutomationWorkspaceProvenance | undefined {
  const { authority, repoSelector, repo, request } = args
  if (!request) {
    return undefined
  }

  let automation: Automation
  try {
    automation = authority.showAutomation(request.automationId)
  } catch (error) {
    // Why: an older desktop sends its own unverifiable token (#34433); store failures still surface.
    if (args.ignoreUnknownAutomation) {
      if (isUnownedAutomationError(error)) {
        return undefined
      }
      throw error
    }
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

/** Label a workspace with another owner's run, never one this host holds; a label grants nothing here. */
export function resolveClientAutomationWorkspaceProvenance(args: {
  authority: Pick<AutomationWorkspaceProvenanceAuthority, 'showAutomation'>
  provenance: unknown
}): AutomationWorkspaceProvenance | undefined {
  if (args.provenance === undefined) {
    return undefined
  }
  const parsed = ClientAutomationWorkspaceProvenance.safeParse(args.provenance)
  if (!parsed.success) {
    warnDroppedClientAutomationLabel()
    return undefined
  }
  const provenance = parsed.data
  try {
    args.authority.showAutomation(provenance.automationId)
    // Why: a host-held automation is proven only by its own dispatch token.
    return undefined
  } catch (error) {
    if (!isUnownedAutomationError(error)) {
      throw error
    }
  }
  return { ...provenance, kind: 'created-by-automation', createdAt: Date.now(), origin: 'client' }
}

let droppedClientAutomationLabelWarned = false

function warnDroppedClientAutomationLabel(): void {
  if (!droppedClientAutomationLabelWarned) {
    droppedClientAutomationLabelWarned = true
    console.warn(
      '[automations] dropped a malformed client automation label; creating a plain workspace'
    )
  }
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
