import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import { carryProjectStateThroughIdentityChange } from '../../shared/project-identity-succession'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import { getOrcaProfileDataFile } from './profile-index-store'
import {
  readWorkspaceSessionSidecarsForProfile,
  replaceWorkspaceSessionSidecarsSync
} from '../persistence/loading-store/workspace-session-sidecar'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export type TransferProfileState = PersistedState

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return isRecord(value) ? (value as Record<string, T>) : {}
}

export function readProfileState(profileId: string, userDataPath: string): TransferProfileState {
  const defaults = getDefaultPersistedState(homedir())
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  if (!existsSync(dataFile)) {
    return structuredClone(defaults)
  }
  const parsed = JSON.parse(readFileSync(dataFile, 'utf-8')) as Partial<PersistedState>
  const state = rebuildRepoBackedProjectState({
    ...defaults,
    ...parsed,
    repos: arrayOrEmpty<Repo>(parsed.repos),
    projects: arrayOrEmpty<Project>(parsed.projects),
    projectHostSetups: arrayOrEmpty<ProjectHostSetup>(parsed.projectHostSetups),
    projectGroups: arrayOrEmpty(parsed.projectGroups),
    folderWorkspaces: arrayOrEmpty(parsed.folderWorkspaces),
    sparsePresetsByRepo: recordOrEmpty<SparsePreset[]>(parsed.sparsePresetsByRepo),
    retiredWorktreeNamesByRepo: recordOrEmpty<RetiredNameRegistry>(
      parsed.retiredWorktreeNamesByRepo
    ),
    retiredWorktreeNamesByNamespace: recordOrEmpty<RetiredNameRegistry>(
      parsed.retiredWorktreeNamesByNamespace
    ),
    worktreeMeta: recordOrEmpty(parsed.worktreeMeta),
    worktreeLineageById: recordOrEmpty(parsed.worktreeLineageById),
    workspaceLineageByChildKey: recordOrEmpty(parsed.workspaceLineageByChildKey),
    settings: isRecord(parsed.settings)
      ? { ...defaults.settings, ...parsed.settings }
      : defaults.settings,
    ui: isRecord(parsed.ui) ? { ...defaults.ui, ...parsed.ui } : defaults.ui,
    githubCache: isRecord(parsed.githubCache)
      ? {
          pr: recordOrEmpty((parsed.githubCache as PersistedState['githubCache']).pr),
          issue: recordOrEmpty((parsed.githubCache as PersistedState['githubCache']).issue)
        }
      : defaults.githubCache,
    workspaceSession: isRecord(parsed.workspaceSession)
      ? { ...getDefaultWorkspaceSession(), ...parsed.workspaceSession }
      : defaults.workspaceSession,
    workspaceSessionsByHostId: isRecord(parsed.workspaceSessionsByHostId)
      ? (parsed.workspaceSessionsByHostId as Partial<
          Record<ExecutionHostId, WorkspaceSessionState>
        >)
      : {},
    sshTargets: arrayOrEmpty(parsed.sshTargets),
    sshRemotePtyLeases: arrayOrEmpty(parsed.sshRemotePtyLeases),
    migrationUnsupportedPtyEntries: arrayOrEmpty(parsed.migrationUnsupportedPtyEntries),
    legacyPaneKeyAliasEntries: arrayOrEmpty(parsed.legacyPaneKeyAliasEntries),
    automations: arrayOrEmpty(parsed.automations),
    automationRuns: arrayOrEmpty(parsed.automationRuns),
    onboarding: isRecord(parsed.onboarding)
      ? { ...defaults.onboarding, ...parsed.onboarding }
      : defaults.onboarding,
    featureInteractionTelemetryBuckets: isRecord(parsed.featureInteractionTelemetryBuckets)
      ? parsed.featureInteractionTelemetryBuckets
      : defaults.featureInteractionTelemetryBuckets
  })
  const embeddedHostIds = new Set<ExecutionHostId>()
  if (isRecord(parsed.workspaceSessionsByHostId)) {
    for (const rawHostId of Object.keys(parsed.workspaceSessionsByHostId)) {
      const hostId = normalizeExecutionHostId(rawHostId)
      if (hostId && hostId !== 'local') {
        embeddedHostIds.add(hostId)
      }
    }
  }
  return {
    ...state,
    ...readWorkspaceSessionSidecarsForProfile({
      dataFile,
      workspaceSession: state.workspaceSession,
      workspaceSessionsByHostId: state.workspaceSessionsByHostId,
      embeddedLocalPresent: parsed.workspaceSession !== undefined,
      embeddedHostIds,
      embeddedPayloadPresent:
        parsed.workspaceSession !== undefined || parsed.workspaceSessionsByHostId !== undefined,
      embeddedGenerationByHostId: state.workspaceSessionSidecarGenerationByHostId,
      replacementPending: state.workspaceSessionSidecarReplacementPending
    })
  }
}
export type ProfileStateWriteOptions = {
  afterJournalWrite?: () => void
  afterSidecarReplacement?: () => void
}

export function writeProfileState(
  profileId: string,
  userDataPath: string,
  state: TransferProfileState,
  options: ProfileStateWriteOptions = {}
): void {
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  mkdirSync(dirname(dataFile), { recursive: true })
  const writeCore = (coreState: TransferProfileState): void => {
    writeFileDurableSync(
      durableWriteTempPath(dataFile),
      dataFile,
      JSON.stringify(coreState, null, 2)
    )
  }
  // Journal first: if sidecar publication or pruning stops halfway, the complete embedded
  // projection remains authoritative and the next load repairs every partition.
  writeCore({
    ...state,
    workspaceSessionSidecarGenerationByHostId: {},
    workspaceSessionSidecarReplacementPending: true
  })
  options.afterJournalWrite?.()
  const generations = replaceWorkspaceSessionSidecarsSync({
    dataFile,
    workspaceSession: state.workspaceSession,
    workspaceSessionsByHostId: state.workspaceSessionsByHostId
  })
  options.afterSidecarReplacement?.()
  writeCore({
    ...state,
    workspaceSessionSidecarGenerationByHostId: generations,
    workspaceSessionSidecarReplacementPending: false
  })
}

function isRepoBackedProjectHostSetup(
  setup: ProjectHostSetup,
  currentRepoIds: ReadonlySet<string>
): boolean {
  return Boolean(setup.repoId && currentRepoIds.has(setup.repoId))
}

export function rebuildRepoBackedProjectState(state: TransferProfileState): TransferProfileState {
  const projection = projectHostSetupProjectionFromRepos(state.repos)
  const succession = carryProjectStateThroughIdentityChange(projection.projects, state.projects)
  const currentRepoIds = new Set(state.repos.map((repo) => repo.id))
  const projectedProjectIds = new Set(projection.projects.map((project) => project.id))
  const projectedSetupIds = new Set(projection.setups.map((setup) => setup.id))
  const independentSetups = state.projectHostSetups
    .filter((setup) => {
      if (projectedSetupIds.has(setup.id)) {
        return false
      }
      return !isRepoBackedProjectHostSetup(setup, currentRepoIds)
    })
    // Why: follow the repo's project through a derived-id change so no ghost project row survives.
    .map((setup) => {
      const remappedProjectId = succession.remappedProjectIds.get(setup.projectId)
      return remappedProjectId ? { ...setup, projectId: remappedProjectId } : setup
    })
  const independentProjectIds = new Set(independentSetups.map((setup) => setup.projectId))
  const independentProjects = state.projects
    .filter(
      (project) => independentProjectIds.has(project.id) && !projectedProjectIds.has(project.id)
    )
    .map((project) => ({
      ...project,
      sourceRepoIds: project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
    }))
  return {
    ...state,
    projects: [...succession.projects, ...independentProjects],
    projectHostSetups: [...projection.setups, ...independentSetups]
  }
}
