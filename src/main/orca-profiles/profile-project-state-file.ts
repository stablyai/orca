import { isRepoBackedProjectHostSetup } from '../persistence/tracking-repos/project-host-compatibility'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
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
import { getOrcaProfileDataFile, getOrcaProfileStateDatabaseFile } from './profile-index-store'
import {
  importProfileStateJson,
  profileStateJsonMatchesAcceptance,
  readProfileStateRevision,
  readProfileStateSnapshot
} from '../persistence/profile-state/profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import { parseProfileStateRoot } from '../persistence/profile-state/profile-state-document-validation'
import { assertProfileStateCanInitialize } from '../persistence/profile-state/profile-state-recovery-required'
import { hasProfileStateDatabaseFiles } from '../persistence/profile-state/profile-state-storage-classification'
import { ensureProfileStateAuthorityMarker } from '../persistence/profile-state/profile-state-authority-marker'

export type TransferProfileState = PersistedState

export type ReadProfileStateResult = {
  state: TransferProfileState
  /** Snapshot revision; absent for legacy JSON. */
  revision?: number
  /** Exact compact snapshot JSON. */
  serialized?: string
}

export class AmbiguousProfileStateStorageError extends Error {
  readonly code = 'ambiguous_profile_state_storage' as const

  constructor(profileId: string, message?: string) {
    super(message ?? `Profile ${profileId} has both SQLite and legacy JSON state`)
    this.name = 'AmbiguousProfileStateStorageError'
  }
}

export type ProfileStateStorage = 'json' | 'sqlite'

export function profileStateStorage(profileId: string, userDataPath: string): ProfileStateStorage {
  const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  const hasJson = existsSync(dataFile)
  const hasDatabase = hasProfileStateDatabaseFiles(databaseFile)
  if (hasJson && hasDatabase) {
    assertAcceptedLegacyJsonMirror(profileId, dataFile, databaseFile)
    return 'sqlite'
  }
  if (!hasDatabase) {
    assertProfileStateCanInitialize({ dataFile, databaseFile, profileId })
  }
  return hasDatabase ? 'sqlite' : 'json'
}

/** Accept SQLite beside retained JSON only when its marker matches that exact export; fail closed otherwise. */
function assertAcceptedLegacyJsonMirror(
  profileId: string,
  dataFile: string,
  databaseFile: string
): void {
  const rawJson = readFileSync(dataFile, 'utf-8')
  const opened = openProfileStateDatabaseReadOnly(databaseFile, profileId)
  try {
    if (!profileStateJsonMatchesAcceptance(opened.db, rawJson)) {
      throw new AmbiguousProfileStateStorageError(profileId)
    }
  } finally {
    opened.db.close()
  }
}

export function readProfileStateWithRevision(
  profileId: string,
  userDataPath: string
): ReadProfileStateResult {
  const storage = profileStateStorage(profileId, userDataPath)
  if (storage === 'json') {
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    const serialized = existsSync(dataFile) ? readFileSync(dataFile, 'utf-8') : undefined
    return { state: parseProfileState(serialized), ...(serialized ? { serialized } : {}) }
  }

  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  const opened = openProfileStateDatabaseReadOnly(databaseFile, profileId)
  try {
    const snapshot = readProfileStateSnapshot(opened.db)
    return {
      state: parseProfileState(snapshot.json),
      revision: snapshot.revision,
      serialized: snapshot.json
    }
  } finally {
    opened.db.close()
  }
}

function parseProfileState(rawJson: string | undefined): TransferProfileState {
  if (rawJson === undefined) {
    return structuredClone(getDefaultPersistedState(homedir()))
  }
  return normalizeProfileProjectState(parseProfileStateRoot(rawJson))
}

export function normalizeProfileProjectState(
  parsed: Partial<PersistedState>
): TransferProfileState {
  const defaults = getDefaultPersistedState(homedir())
  const { uiLanguagePortugueseMigrationApplied: _migrationApplied, ...settingsDefaults } =
    defaults.settings
  return rebuildRepoBackedProjectState({
    ...defaults,
    ...parsed,
    repos: arrayOrEmpty<Repo>(parsed.repos),
    // Inactive-profile JSON is untrusted; normalize rows before importing them.
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
      ? { ...settingsDefaults, ...parsed.settings }
      : settingsDefaults,
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
  return readProfileStateWithRevision(profileId, userDataPath).state
}

export function writeProfileState(
  profileId: string,
  userDataPath: string,
  state: TransferProfileState,
  options: { expectedRevision?: number } = {}
): void {
  writeSerializedProfileState(profileId, userDataPath, JSON.stringify(state), options)
}

/** Preserve validated projection bytes exactly in SQLite. */
export function writeSerializedProfileState(
  profileId: string,
  userDataPath: string,
  serialized: string,
  options: { expectedRevision?: number } = {}
): void {
  if (profileStateStorage(profileId, userDataPath) !== 'sqlite') {
    throw new Error('Profile transfer write requires an established SQLite participant')
  }
  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    ensureProfileStateAuthorityMarker(databaseFile)
    importProfileStateJson(opened.db, serialized, {
      expectedRevision: options.expectedRevision ?? readProfileStateRevision(opened.db)
    })
  } finally {
    opened.db.close()
  }
}

export function rebuildRepoBackedProjectState(state: TransferProfileState): TransferProfileState {
  const projection = projectHostSetupProjectionFromRepos(state.repos)
  const succession = carryProjectStateThroughIdentityChange(projection.projects, state.projects, {
    previous: state.projectHostSetups,
    current: projection.setups
  })
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
    // Follow derived project-ID changes so no ghost setup row survives.
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
