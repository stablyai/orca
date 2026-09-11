import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import {
  normalizeProjectHostSetupRows,
  normalizeProjectRows
} from '../../shared/project-catalog-row-normalization'
import { carryProjectStateThroughIdentityChange } from '../../shared/project-identity-succession'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { Project, ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SparsePreset } from '../../shared/worktree/create-types'
import type { RetiredNameRegistry } from '../../shared/worktree/retired-name-registry'
import { getOrcaProfileDataFile } from './profile-index-store'

export type TransferProfileState = PersistedState

function isRecord<T>(value: unknown): value is Record<string, T> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? value : []
}

function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return isRecord<T>(value) ? value : {}
}

export function readProfileState(profileId: string, userDataPath: string): TransferProfileState {
  const defaults = getDefaultPersistedState(homedir())
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  if (!existsSync(dataFile)) {
    return structuredClone(defaults)
  }
  const parsed: Partial<PersistedState> = JSON.parse(readFileSync(dataFile, 'utf-8'))
  return rebuildRepoBackedProjectState({
    ...defaults,
    ...parsed,
    repos: arrayOrEmpty<Repo>(parsed.repos),
    // Why normalize: another profile's file is untrusted JSON, and a null repoId/path here would be
    // carried straight into the importing app's state.
    projects: normalizeProjectRows(arrayOrEmpty<Project>(parsed.projects)),
    projectHostSetups: normalizeProjectHostSetupRows(
      arrayOrEmpty<ProjectHostSetup>(parsed.projectHostSetups)
    ),
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
          pr: recordOrEmpty(parsed.githubCache.pr),
          issue: recordOrEmpty(parsed.githubCache.issue)
        }
      : defaults.githubCache,
    workspaceSession: isRecord(parsed.workspaceSession)
      ? { ...getDefaultWorkspaceSession(), ...parsed.workspaceSession }
      : defaults.workspaceSession,
    workspaceSessionsByHostId: isRecord<WorkspaceSessionState>(parsed.workspaceSessionsByHostId)
      ? parsed.workspaceSessionsByHostId
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
