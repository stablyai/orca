import type {
  Automation,
  AutomationPrecheckResult,
  AutomationRun,
  AutomationRunOutputSnapshot,
  AutomationSchedulerOwner
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { normalizeAutomationPrecheck } from '../../../shared/automation-precheck'
import { getAutomationLegacyRepoId } from '../../../shared/automation-run-identity'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import {
  buildTaskSourceContextFromRepo,
  buildWorkspaceRunContext
} from '../../../shared/task-source-context'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'

export function normalizeAutomationRunWorkspaceDisplayName(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function normalizeAutomationRunTerminalPaneKey(
  value: string | null | undefined
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed && parsePaneKey(trimmed) ? trimmed : null
}

export function normalizeAutomationRunTerminalPtyId(
  value: string | null | undefined
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || null
}

export function normalizeAutomationRunOutputSnapshot(
  value: AutomationRunOutputSnapshot | null | undefined
): AutomationRunOutputSnapshot | null {
  if (!value || value.format !== 'plain_text') {
    return null
  }
  const content = typeof value.content === 'string' ? value.content : ''
  if (!content.trim()) {
    return null
  }
  return {
    format: 'plain_text',
    content,
    capturedAt:
      typeof value.capturedAt === 'number' && Number.isFinite(value.capturedAt)
        ? value.capturedAt
        : Date.now(),
    truncated: value.truncated === true
  }
}

export function normalizeAutomationPrecheckResult(
  value: AutomationPrecheckResult | null | undefined
): AutomationPrecheckResult | null {
  if (!value || typeof value.command !== 'string' || !value.command.trim()) {
    return null
  }
  const startedAt =
    typeof value.startedAt === 'number' && Number.isFinite(value.startedAt)
      ? value.startedAt
      : Date.now()
  const completedAt =
    typeof value.completedAt === 'number' && Number.isFinite(value.completedAt)
      ? value.completedAt
      : startedAt
  return {
    command: value.command.trim(),
    exitCode:
      typeof value.exitCode === 'number' && Number.isFinite(value.exitCode) ? value.exitCode : null,
    timedOut: value.timedOut === true,
    durationMs:
      typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
        ? Math.max(0, value.durationMs)
        : Math.max(0, completedAt - startedAt),
    stdout: typeof value.stdout === 'string' ? value.stdout : '',
    stderr: typeof value.stderr === 'string' ? value.stderr : '',
    stdoutTruncated: value.stdoutTruncated === true,
    stderrTruncated: value.stderrTruncated === true,
    error: typeof value.error === 'string' && value.error.trim() ? value.error : null,
    startedAt,
    completedAt
  }
}

export function normalizeAutomationSessionReuse(automation: Automation): Automation {
  const setupDecision = normalizeAutomationSetupDecisionForWorkspaceMode(
    automation.workspaceMode,
    automation.setupDecision
  )
  return {
    ...automation,
    precheck: normalizeAutomationPrecheck(automation.precheck),
    setupDecision,
    reuseSession: automation.workspaceMode === 'existing' && automation.reuseSession === true
  }
}

export function normalizeAutomationSetupDecisionForWorkspaceMode(
  workspaceMode: Automation['workspaceMode'],
  setupDecision: unknown
): Automation['setupDecision'] {
  return workspaceMode === 'new_per_run' && (setupDecision === 'run' || setupDecision === 'skip')
    ? setupDecision
    : undefined
}

export function getAutomationContextsForRepo(
  repo: Repo | undefined,
  projectHostSetups: readonly ProjectHostSetup[]
): Pick<Automation, 'runContext' | 'sourceContext'> {
  if (!repo) {
    return {
      runContext: null,
      sourceContext: null
    }
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const projectedProject = projection.projects[0]
  const projectedSetup = projection.setups[0]
  // Why the host filter first: a repo id can be shared across hosts, and the
  // contexts must describe the copy this record resolved to, not a sibling's.
  const repoHostId = getRepoExecutionHostId(repo)
  const setup =
    projectHostSetups.find(
      (candidate) => candidate.repoId === repo.id && candidate.hostId === repoHostId
    ) ??
    projectHostSetups.find((candidate) => candidate.repoId === repo.id) ??
    projectedSetup
  const runContext = setup
    ? buildWorkspaceRunContext({
        projectId: setup.projectId,
        hostId: setup.hostId,
        projectHostSetupId: setup.id,
        repoId: repo.id,
        path: setup.path
      })
    : null
  const providerIdentity = projectedProject?.providerIdentity
  const sourceContext = providerIdentity
    ? buildTaskSourceContextFromRepo({
        provider: providerIdentity.provider,
        projectId: providerIdentity.provider === 'github' ? (setup?.projectId ?? repo.id) : repo.id,
        repo,
        projectHostSetupId: setup?.id,
        providerIdentity
      })
    : null
  return {
    runContext,
    sourceContext
  }
}

export function getAutomationSchedulerOwner(repo: Repo | undefined): AutomationSchedulerOwner {
  if (!repo) {
    return 'local_host_service'
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'ssh') {
    return 'ssh_bridge'
  }
  if (host?.kind === 'runtime') {
    return 'remote_host_service'
  }
  return 'local_host_service'
}

export function backfillLegacyAutomationContexts(
  state: Pick<PersistedState, 'automations' | 'automationRuns' | 'repos' | 'projectHostSetups'>
): {
  state: Pick<PersistedState, 'automations' | 'automationRuns' | 'repos' | 'projectHostSetups'>
  changed: boolean
} {
  let changed = false
  const contextsByAutomationId = new Map<string, Pick<Automation, 'runContext' | 'sourceContext'>>()
  const reposById = new Map((state.repos ?? []).map((repo) => [repo.id, repo]))
  const automations = (state.automations ?? []).map((automation) => {
    const contexts = getAutomationContextsForRepo(
      reposById.get(getAutomationLegacyRepoId(automation)),
      state.projectHostSetups ?? []
    )
    const next: Automation = { ...automation }
    if (!Object.hasOwn(next, 'runContext')) {
      // Why: pre-host-context automations only stored a repo id; backfill the run target once so dispatch/precheck stop inferring it.
      next.runContext = contexts.runContext
      changed = true
    }
    if (!Object.hasOwn(next, 'sourceContext')) {
      next.sourceContext = contexts.sourceContext
      changed = true
    }
    contextsByAutomationId.set(next.id, {
      runContext: next.runContext ?? null,
      sourceContext: next.sourceContext ?? null
    })
    return next
  })
  const automationRuns = (state.automationRuns ?? []).map((run) => {
    const automationContexts = contextsByAutomationId.get(run.automationId)
    const next: AutomationRun = { ...run }
    if (!Object.hasOwn(next, 'runContext')) {
      next.runContext = automationContexts?.runContext ?? null
      changed = true
    }
    if (!Object.hasOwn(next, 'sourceContext')) {
      next.sourceContext = automationContexts?.sourceContext ?? null
      changed = true
    }
    if (!Object.hasOwn(next, 'terminalPaneKey')) {
      next.terminalPaneKey = null
      changed = true
    }
    if (!Object.hasOwn(next, 'terminalPtyId')) {
      next.terminalPtyId = null
      changed = true
    }
    return next
  })
  if (!changed) {
    return { state, changed: false }
  }
  return {
    state: {
      ...state,
      automations,
      automationRuns
    },
    changed: true
  }
}
