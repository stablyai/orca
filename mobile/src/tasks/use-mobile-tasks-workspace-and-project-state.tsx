import type { RouteAndItemStateModel } from './use-mobile-tasks-route-and-item-state'
import {
  type BaseRefSearchResult,
  type GitHubProjectPartialFailure,
  type GitHubProjectRef,
  type GitHubProjectSettings,
  type GitHubProjectSummary,
  type GitHubProjectViewSummary,
  type PersistedTrustedOrcaHooks,
  type SparsePreset,
  type SshConnectionState,
  type WorkspaceAgentChoice,
  useState
} from './mobile-tasks-dependencies'
import {
  type DetailPayload,
  EMPTY_GITHUB_PROJECT_SETTINGS,
  type GitHubAssignableUser,
  type GitHubIssueType,
  type GitHubProjectRow,
  type GitHubProjectTable,
  type LinearState,
  type OrcaYamlTrustPrompt,
  type ProjectRepoNotInOrcaPrompt,
  type ProjectSortOverride,
  type RuntimeTaskSettings,
  type SetupPrompt,
  type TaskItem,
  type WorkspaceCreateDraft,
  type WorkspaceSparseDraft
} from './mobile-tasks-model'

export function useMobileTasksWorkspaceAndProjectState(model: RouteAndItemStateModel) {
  const [workspaceRepoPickerItem, setWorkspaceRepoPickerItem] = useState<Extract<
    TaskItem,
    { provider: 'linear' }
  > | null>(null)
  const [workspaceCreateDraft, setWorkspaceCreateDraft] = useState<WorkspaceCreateDraft | null>(
    null
  )
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState('')
  const [workspaceLastAutoName, setWorkspaceLastAutoName] = useState('')
  const [workspaceBranchAutoName, setWorkspaceBranchAutoName] = useState('')
  const [workspaceBranchNameOverride, setWorkspaceBranchNameOverride] = useState<
    string | undefined
  >(undefined)
  const [workspaceBaseBranch, setWorkspaceBaseBranch] = useState<BaseRefSearchResult | null>(null)
  const [workspaceBaseBranchQuery, setWorkspaceBaseBranchQuery] = useState('')
  const [workspaceBaseBranchResults, setWorkspaceBaseBranchResults] = useState<
    BaseRefSearchResult[]
  >([])
  const [workspaceBaseBranchLoading, setWorkspaceBaseBranchLoading] = useState(false)
  const [workspaceBaseBranchError, setWorkspaceBaseBranchError] = useState('')
  const [workspaceSparsePresets, setWorkspaceSparsePresets] = useState<SparsePreset[]>([])
  const [workspaceSparsePresetsLoading, setWorkspaceSparsePresetsLoading] = useState(false)
  const [workspaceSparsePresetsLoaded, setWorkspaceSparsePresetsLoaded] = useState(false)
  const [_workspaceSparsePresetsError, setWorkspaceSparsePresetsError] = useState('')
  const [workspaceSparseReloadKey, setWorkspaceSparseReloadKey] = useState(0)
  const [workspaceSparsePresetId, setWorkspaceSparsePresetId] = useState<string | null>(null)
  const [workspaceSparseDraft, setWorkspaceSparseDraft] = useState<WorkspaceSparseDraft | null>(
    null
  )
  const [workspaceSparseSaving, setWorkspaceSparseSaving] = useState(false)
  const [workspaceAgent, setWorkspaceAgent] = useState<WorkspaceAgentChoice | null>(null)
  const [workspaceAgentOverridden, setWorkspaceAgentOverridden] = useState(false)
  const [workspaceDetectedAgentIds, setWorkspaceDetectedAgentIds] = useState<Set<string> | null>(
    null
  )
  const [workspaceSshState, setWorkspaceSshState] = useState<SshConnectionState | null>(null)
  const [workspaceSshConnecting, setWorkspaceSshConnecting] = useState(false)
  const [showWorkspaceAgentPicker, setShowWorkspaceAgentPicker] = useState(false)
  const [showWorkspaceCreateRepoPicker, setShowWorkspaceCreateRepoPicker] = useState(false)
  const [showWorkspaceAdvanced, setShowWorkspaceAdvanced] = useState(false)
  const [showWorkspaceBaseBranchPicker, setShowWorkspaceBaseBranchPicker] = useState(false)
  const [showWorkspaceSparsePicker, setShowWorkspaceSparsePicker] = useState(false)
  const [linearStatusPickerItem, setLinearStatusPickerItem] = useState<Extract<
    TaskItem,
    { provider: 'linear' }
  > | null>(null)
  const [setupPrompt, setSetupPrompt] = useState<SetupPrompt | null>(null)
  const [creatingKey, setCreatingKey] = useState<string | null>(null)
  const [mutatingStatus, setMutatingStatus] = useState(false)
  const [linearStates, setLinearStates] = useState<LinearState[]>([])
  const [linearStatesLoading, setLinearStatesLoading] = useState(false)
  const [linearCommentDraft, setLinearCommentDraft] = useState('')
  const [linearSubIssueTitle, setLinearSubIssueTitle] = useState('')
  const [taskStateHydrated, setTaskStateHydrated] = useState(false)
  const [runtimeTaskSettings, setRuntimeTaskSettings] = useState<RuntimeTaskSettings>({})
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [orcaYamlTrustPrompt, setOrcaYamlTrustPrompt] = useState<OrcaYamlTrustPrompt | null>(null)
  const [githubProjectSettings, setGithubProjectSettings] = useState<GitHubProjectSettings>(
    EMPTY_GITHUB_PROJECT_SETTINGS
  )
  const [githubProjects, setGithubProjects] = useState<GitHubProjectSummary[]>([])
  const [githubProjectViews, setGithubProjectViews] = useState<GitHubProjectViewSummary[]>([])
  const [githubProjectTable, setGithubProjectTable] = useState<GitHubProjectTable | null>(null)
  const [githubProjectLoading, setGithubProjectLoading] = useState(false)
  const [githubProjectError, setGithubProjectError] = useState('')
  const [githubProjectPartialFailures, setGithubProjectPartialFailures] = useState<
    GitHubProjectPartialFailure[]
  >([])
  const [githubProjectSearch, setGithubProjectSearch] = useState('')
  const [githubProjectPickerSearch, setGithubProjectPickerSearch] = useState('')
  const [githubProjectPasteInput, setGithubProjectPasteInput] = useState('')
  const [githubProjectPasteError, setGithubProjectPasteError] = useState('')
  const [githubProjectPasteBusy, setGithubProjectPasteBusy] = useState(false)
  const [appliedGithubProjectSearch, setAppliedGithubProjectSearch] = useState<string | undefined>(
    undefined
  )
  const [githubProjectSortOverride, setGithubProjectSortOverride] =
    useState<ProjectSortOverride | null>(null)
  const [githubProjectHiddenFieldIdsByView, setGithubProjectHiddenFieldIdsByView] = useState<
    Record<string, string[]>
  >({})
  const [collapsedGitHubProjectGroups, setCollapsedGitHubProjectGroups] = useState<Set<string>>(
    () => new Set()
  )
  const [showGitHubProjectPicker, setShowGitHubProjectPicker] = useState(false)
  const [showGitHubProjectViewPicker, setShowGitHubProjectViewPicker] = useState(false)
  const [showGitHubProjectSortPicker, setShowGitHubProjectSortPicker] = useState(false)
  const [showGitHubProjectFieldsPicker, setShowGitHubProjectFieldsPicker] = useState(false)
  const [pendingGitHubProjectViewSelection, setPendingGitHubProjectViewSelection] =
    useState<GitHubProjectRef | null>(null)
  const [projectRowItem, setProjectRowItem] = useState<GitHubProjectRow | null>(null)
  const [projectRowDetail, setProjectRowDetail] = useState<DetailPayload | null>(null)
  const [projectRowDetailLoading, setProjectRowDetailLoading] = useState(false)
  const [projectRowDetailError, setProjectRowDetailError] = useState('')
  const [projectRowDetailRefreshSeq, setProjectRowDetailRefreshSeq] = useState(0)
  const [projectTitleDraft, setProjectTitleDraft] = useState('')
  const [projectBodyDraft, setProjectBodyDraft] = useState('')
  const [projectCommentDraft, setProjectCommentDraft] = useState('')
  const [projectEditingCommentId, setProjectEditingCommentId] = useState<string | null>(null)
  const [projectEditingCommentDraft, setProjectEditingCommentDraft] = useState('')
  const [projectReviewersDraft, setProjectReviewersDraft] = useState('')
  const [projectFieldDrafts, setProjectFieldDrafts] = useState<Record<string, string>>({})
  const [projectAvailableLabels, setProjectAvailableLabels] = useState<string[]>([])
  const [projectLabelsLoading, setProjectLabelsLoading] = useState(false)
  const [projectLabelsError, setProjectLabelsError] = useState('')
  const [projectAssignableUsers, setProjectAssignableUsers] = useState<GitHubAssignableUser[]>([])
  const [projectAssignableUsersLoading, setProjectAssignableUsersLoading] = useState(false)
  const [projectAssignableUsersError, setProjectAssignableUsersError] = useState('')
  const [projectIssueTypes, setProjectIssueTypes] = useState<GitHubIssueType[]>([])
  const [projectIssueTypesLoading, setProjectIssueTypesLoading] = useState(false)
  const [projectIssueTypesError, setProjectIssueTypesError] = useState('')
  const [projectMutating, setProjectMutating] = useState(false)
  const [projectRepoNotInOrca, setProjectRepoNotInOrca] =
    useState<ProjectRepoNotInOrcaPrompt | null>(null)
  return Object.assign(model, {
    appliedGithubProjectSearch,
    collapsedGitHubProjectGroups,
    creatingKey,
    githubProjectError,
    githubProjectHiddenFieldIdsByView,
    githubProjectLoading,
    githubProjectPartialFailures,
    githubProjectPasteBusy,
    githubProjectPasteError,
    githubProjectPasteInput,
    githubProjectPickerSearch,
    githubProjectSearch,
    githubProjectSettings,
    githubProjectSortOverride,
    githubProjectTable,
    githubProjectViews,
    githubProjects,
    linearCommentDraft,
    linearStates,
    linearStatesLoading,
    linearStatusPickerItem,
    linearSubIssueTitle,
    mutatingStatus,
    orcaYamlTrustPrompt,
    pendingGitHubProjectViewSelection,
    projectAssignableUsers,
    projectAssignableUsersError,
    projectAssignableUsersLoading,
    projectAvailableLabels,
    projectBodyDraft,
    projectCommentDraft,
    projectEditingCommentDraft,
    projectEditingCommentId,
    projectFieldDrafts,
    projectIssueTypes,
    projectIssueTypesError,
    projectIssueTypesLoading,
    projectLabelsError,
    projectLabelsLoading,
    projectMutating,
    projectRepoNotInOrca,
    projectReviewersDraft,
    projectRowDetail,
    projectRowDetailError,
    projectRowDetailLoading,
    projectRowDetailRefreshSeq,
    projectRowItem,
    projectTitleDraft,
    runtimeTaskSettings,
    setAppliedGithubProjectSearch,
    setCollapsedGitHubProjectGroups,
    setCreatingKey,
    setGithubProjectError,
    setGithubProjectHiddenFieldIdsByView,
    setGithubProjectLoading,
    setGithubProjectPartialFailures,
    setGithubProjectPasteBusy,
    setGithubProjectPasteError,
    setGithubProjectPasteInput,
    setGithubProjectPickerSearch,
    setGithubProjectSearch,
    setGithubProjectSettings,
    setGithubProjectSortOverride,
    setGithubProjectTable,
    setGithubProjectViews,
    setGithubProjects,
    setLinearCommentDraft,
    setLinearStates,
    setLinearStatesLoading,
    setLinearStatusPickerItem,
    setLinearSubIssueTitle,
    setMutatingStatus,
    setOrcaYamlTrustPrompt,
    setPendingGitHubProjectViewSelection,
    setProjectAssignableUsers,
    setProjectAssignableUsersError,
    setProjectAssignableUsersLoading,
    setProjectAvailableLabels,
    setProjectBodyDraft,
    setProjectCommentDraft,
    setProjectEditingCommentDraft,
    setProjectEditingCommentId,
    setProjectFieldDrafts,
    setProjectIssueTypes,
    setProjectIssueTypesError,
    setProjectIssueTypesLoading,
    setProjectLabelsError,
    setProjectLabelsLoading,
    setProjectMutating,
    setProjectRepoNotInOrca,
    setProjectReviewersDraft,
    setProjectRowDetail,
    setProjectRowDetailError,
    setProjectRowDetailLoading,
    setProjectRowDetailRefreshSeq,
    setProjectRowItem,
    setProjectTitleDraft,
    setRuntimeTaskSettings,
    setSetupPrompt,
    setShowGitHubProjectFieldsPicker,
    setShowGitHubProjectPicker,
    setShowGitHubProjectSortPicker,
    setShowGitHubProjectViewPicker,
    setShowWorkspaceAdvanced,
    setShowWorkspaceAgentPicker,
    setShowWorkspaceBaseBranchPicker,
    setShowWorkspaceCreateRepoPicker,
    setShowWorkspaceSparsePicker,
    setTaskStateHydrated,
    setTrustedOrcaHooks,
    setWorkspaceAgent,
    setWorkspaceAgentOverridden,
    setWorkspaceBaseBranch,
    setWorkspaceBaseBranchError,
    setWorkspaceBaseBranchLoading,
    setWorkspaceBaseBranchQuery,
    setWorkspaceBaseBranchResults,
    setWorkspaceBranchAutoName,
    setWorkspaceBranchNameOverride,
    setWorkspaceCreateDraft,
    setWorkspaceDetectedAgentIds,
    setWorkspaceLastAutoName,
    setWorkspaceNameDraft,
    setWorkspaceRepoPickerItem,
    setWorkspaceSparseDraft,
    setWorkspaceSparsePresetId,
    setWorkspaceSparsePresets,
    setWorkspaceSparsePresetsError,
    setWorkspaceSparsePresetsLoaded,
    setWorkspaceSparsePresetsLoading,
    setWorkspaceSparseReloadKey,
    setWorkspaceSparseSaving,
    setWorkspaceSshConnecting,
    setWorkspaceSshState,
    setupPrompt,
    showGitHubProjectFieldsPicker,
    showGitHubProjectPicker,
    showGitHubProjectSortPicker,
    showGitHubProjectViewPicker,
    showWorkspaceAdvanced,
    showWorkspaceAgentPicker,
    showWorkspaceBaseBranchPicker,
    showWorkspaceCreateRepoPicker,
    showWorkspaceSparsePicker,
    taskStateHydrated,
    trustedOrcaHooks,
    workspaceAgent,
    workspaceAgentOverridden,
    workspaceBaseBranch,
    workspaceBaseBranchError,
    workspaceBaseBranchLoading,
    workspaceBaseBranchQuery,
    workspaceBaseBranchResults,
    workspaceBranchAutoName,
    workspaceBranchNameOverride,
    workspaceCreateDraft,
    workspaceDetectedAgentIds,
    workspaceLastAutoName,
    workspaceNameDraft,
    workspaceRepoPickerItem,
    workspaceSparseDraft,
    workspaceSparsePresetId,
    workspaceSparsePresets,
    workspaceSparsePresetsLoaded,
    workspaceSparsePresetsLoading,
    workspaceSparseReloadKey,
    workspaceSparseSaving,
    workspaceSshConnecting,
    workspaceSshState
  })
}

export type WorkspaceAndProjectStateModel = ReturnType<
  typeof useMobileTasksWorkspaceAndProjectState
>
