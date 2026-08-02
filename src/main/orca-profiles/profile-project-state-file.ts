import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import type {
  PersistedState,
  Project,
  ProjectHostSetup,
  Repo,
  SparsePreset,
  WorkspaceSessionState
} from '../../shared/types'
import { getOrcaProfileDataFile } from './profile-index-store'

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
  return rebuildRepoBackedProjectState({
    ...defaults,
    ...parsed,
    repos: arrayOrEmpty<Repo>(parsed.repos),
    projects: arrayOrEmpty<Project>(parsed.projects),
    projectHostSetups: arrayOrEmpty<ProjectHostSetup>(parsed.projectHostSetups),
    projectGroups: arrayOrEmpty(parsed.projectGroups),
    folderWorkspaces: arrayOrEmpty(parsed.folderWorkspaces),
    sparsePresetsByRepo: recordOrEmpty<SparsePreset[]>(parsed.sparsePresetsByRepo),
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
}

export function writeProfileState(
  profileId: string,
  userDataPath: string,
  state: TransferProfileState
): void {
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  mkdirSync(dirname(dataFile), { recursive: true })
  const tmpPath = `${dataFile}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
  renameSync(tmpPath, dataFile)
}

function isRepoBackedProjectHostSetup(
  setup: ProjectHostSetup,
  currentRepoIds: ReadonlySet<string>
): boolean {
  return Boolean(setup.repoId && currentRepoIds.has(setup.repoId))
}

export function rebuildRepoBackedProjectState(state: TransferProfileState): TransferProfileState {
  const projection = projectHostSetupProjectionFromRepos(state.repos)
  const existingProjectsById = new Map(state.projects.map((project) => [project.id, project]))
  const currentRepoIds = new Set(state.repos.map((repo) => repo.id))
  const projectedProjectIds = new Set(projection.projects.map((project) => project.id))
  const projectedSetupIds = new Set(projection.setups.map((setup) => setup.id))
  const independentSetups = state.projectHostSetups.filter((setup) => {
    if (projectedSetupIds.has(setup.id)) {
      return false
    }
    return !isRepoBackedProjectHostSetup(setup, currentRepoIds)
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
  const projectedProjects = projection.projects.map((project) => {
    const existingProject = existingProjectsById.get(project.id)
    return existingProject?.localWindowsRuntimePreference
      ? {
          ...project,
          localWindowsRuntimePreference: existingProject.localWindowsRuntimePreference,
          updatedAt: Math.max(project.updatedAt, existingProject.updatedAt)
        }
      : project
  })
  return {
    ...state,
    projects: [...projectedProjects, ...independentProjects],
    projectHostSetups: [...projection.setups, ...independentSetups]
  }
}
