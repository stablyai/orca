import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { VoiceSettings } from '../../shared/speech-types'

export type RuntimeStore = {
  getRepos: Store['getRepos']
  getRepo: Store['getRepo']
  addRepo: Store['addRepo']
  updateRepo: Store['updateRepo']
  addRetiredWorktreeName?: Store['addRetiredWorktreeName']
  mergeRetiredWorktreeNames?: Store['mergeRetiredWorktreeNames']
  getRetiredWorktreeNameRegistry?: Store['getRetiredWorktreeNameRegistry']
  getRetiredWorktreeNameRegistryForNamespace?: Store['getRetiredWorktreeNameRegistryForNamespace']
  getProjects?: Store['getProjects']
  updateProject?: Store['updateProject']
  getProjectHostSetups?: Store['getProjectHostSetups']
  createProjectHostSetup?: Store['createProjectHostSetup']
  updateProjectHostSetup?: Store['updateProjectHostSetup']
  deleteProjectHostSetup?: Store['deleteProjectHostSetup']
  getProjectGroups?: Store['getProjectGroups']
  createProjectGroup?: Store['createProjectGroup']
  updateProjectGroup?: Store['updateProjectGroup']
  deleteProjectGroup?: Store['deleteProjectGroup']
  moveProjectToGroup?: Store['moveProjectToGroup']
  getFolderWorkspaces?: Store['getFolderWorkspaces']
  createFolderWorkspace?: Store['createFolderWorkspace']
  updateFolderWorkspace?: Store['updateFolderWorkspace']
  removeFolderWorkspace?: Store['removeFolderWorkspace']
  removeProjectForHost?: Store['removeProjectForHost']
  reorderRepos?: Store['reorderRepos']
  getAllWorktreeMeta: Store['getAllWorktreeMeta']
  getAllWorktreeMetaForHost?: Store['getAllWorktreeMetaForHost']
  captureNativeLocalWorktreeMetadataScanExpectation?: Store['captureNativeLocalWorktreeMetadataScanExpectation']
  pruneSessionlessMissingLocalWorktreeMetadataForRepo?: Store['pruneSessionlessMissingLocalWorktreeMetadataForRepo']
  getProfileStorageDirectory?: Store['getProfileStorageDirectory']
  getWorktreeMeta: Store['getWorktreeMeta']
  setWorktreeMeta: Store['setWorktreeMeta']
  setWorktreeMetaForHost?: Store['setWorktreeMetaForHost']
  removeWorktreeMeta: Store['removeWorktreeMeta']
  getWorktreeLineage?: Store['getWorktreeLineage']
  getAllWorktreeLineage?: Store['getAllWorktreeLineage']
  setWorktreeLineage?: Store['setWorktreeLineage']
  removeWorktreeLineage?: Store['removeWorktreeLineage']
  getAllWorkspaceLineage?: Store['getAllWorkspaceLineage']
  setWorkspaceLineage?: Store['setWorkspaceLineage']
  removeWorkspaceLineage?: Store['removeWorkspaceLineage']
  getGitHubCache: Store['getGitHubCache']
  getWorkspaceSession?: Store['getWorkspaceSession']
  getWorkspaceSessionHostIds?: Store['getWorkspaceSessionHostIds']
  onWorkspaceSessionWritten?: Store['onWorkspaceSessionWritten']
  setWorkspaceSession?: Store['setWorkspaceSession']
  runDurableMutation?: Store['runDurableMutation']
  flushOrThrow?: Store['flushOrThrow']
  flushPendingOrThrowAsync?: Store['flushPendingOrThrowAsync']
  stageOrcadMigrationCatalog?: Store['stageOrcadMigrationCatalog']
  commitStagedOrcadMigrationCatalog?: Store['commitStagedOrcadMigrationCatalog']
  stageOrcadMigrationSnapshotChunk?: Store['stageOrcadMigrationSnapshotChunk']
  abortStagedOrcadMigrationCatalog?: Store['abortStagedOrcadMigrationCatalog']
  getOrcadMigrationCatalogState?: Store['getOrcadMigrationCatalogState']
  persistPtyBinding?: Store['persistPtyBinding']
  admitTerminalPane?: Store['admitTerminalPane']
  withdrawTerminalPane?: Store['withdrawTerminalPane']
  getSshRemotePtyLeases?: Store['getSshRemotePtyLeases']
  getUI?: Store['getUI']
  updateUI?: Store['updateUI']
  recordFeatureInteraction?: Store['recordFeatureInteraction']
  listAutomations?: Store['listAutomations']
  listAutomationsForScope?: Store['listAutomationsForScope']
  assertAutomationOwnerFence?: Store['assertAutomationOwnerFence']
  automationOwnerPrecondition?: Store['automationOwnerPrecondition']
  automationChangeSelector?: Store['automationChangeSelector']
  listAutomationRuns?: Store['listAutomationRuns']
  listAutomationRunsPage?: Store['listAutomationRunsPage']
  createAutomation?: Store['createAutomation']
  updateAutomation?: Store['updateAutomation']
  deleteAutomation?: Store['deleteAutomation']
  getSparsePresets?: Store['getSparsePresets']
  saveSparsePreset?: Store['saveSparsePreset']
  getMobileClientTabSelections?: Store['getMobileClientTabSelections']
  setMobileClientTabSelections?: Store['setMobileClientTabSelections']
  getSettings(): {
    workspaceDir: string
    nestWorkspaces: boolean
    // Read by worktree placement: decides whether this project's worktrees
    // mirror into a WSL distro instead of the Windows drive.
    localWindowsRuntimeDefault?: GlobalSettings['localWindowsRuntimeDefault']
    refreshLocalBaseRefOnWorktreeCreate: boolean
    localBaseRefSuggestionDismissed?: boolean
    branchPrefix: string
    branchPrefixCustom: string
    defaultTuiAgent?: GlobalSettings['defaultTuiAgent']
    disabledTuiAgents?: GlobalSettings['disabledTuiAgents']
    agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
    agentDefaultArgs?: GlobalSettings['agentDefaultArgs']
    agentDefaultEnv?: GlobalSettings['agentDefaultEnv']
    terminalWindowsShell?: GlobalSettings['terminalWindowsShell']
    // Read by the launch-line carry rule to name the shell a local line is typed into.
    terminalDefaultShell?: GlobalSettings['terminalDefaultShell']
    floatingTerminalEnabled?: GlobalSettings['floatingTerminalEnabled']
    agentStatusHooksEnabled?: GlobalSettings['agentStatusHooksEnabled']
    terminalCopyTrimsGutter?: GlobalSettings['terminalCopyTrimsGutter']
    experimentalNativeChat?: GlobalSettings['experimentalNativeChat']
    defaultTaskSource?: GlobalSettings['defaultTaskSource']
    defaultTaskViewPreset?: GlobalSettings['defaultTaskViewPreset']
    visibleTaskProviders?: GlobalSettings['visibleTaskProviders']
    defaultRepoSelection?: GlobalSettings['defaultRepoSelection']
    defaultLinearTeamSelection?: GlobalSettings['defaultLinearTeamSelection']
    githubProjects?: GlobalSettings['githubProjects']
    experimentalNewWorktreeCardStyle?: GlobalSettings['experimentalNewWorktreeCardStyle']
    compactWorktreeCards?: GlobalSettings['compactWorktreeCards']
    minimaxGroupId?: GlobalSettings['minimaxGroupId']
    minimaxUsageModels?: GlobalSettings['minimaxUsageModels']
    minimaxEndpoint?: GlobalSettings['minimaxEndpoint']
    zcodePlanSite?: GlobalSettings['zcodePlanSite']
    prBotAuthorOverrides?: GlobalSettings['prBotAuthorOverrides']
    artifactSharingEnabled?: GlobalSettings['artifactSharingEnabled']
    terminalQuickCommands?: GlobalSettings['terminalQuickCommands']
    gitlabProjects?: GlobalSettings['gitlabProjects']
    mobileAutoRestoreFitMs?: number | null
    mobileEmulatorEnabled?: boolean
    mobileEmulatorDefaultDeviceUdid?: string | null
    machineName?: GlobalSettings['machineName']
    voice?: VoiceSettings
    claudeAgentTeamsMode?: GlobalSettings['claudeAgentTeamsMode']
    // Why: Phase-5 query responder kill switches — read per chunk in
    // onPtyData to capture reply ownership at ingestion.
    terminalMainSideEffectAuthority?: GlobalSettings['terminalMainSideEffectAuthority']
    terminalHiddenDeliveryGate?: GlobalSettings['terminalHiddenDeliveryGate']
    terminalModelQueryAuthority?: GlobalSettings['terminalModelQueryAuthority']
    worktreeVisibilityDefaults?: GlobalSettings['worktreeVisibilityDefaults']
    hostSettingOverrides?: GlobalSettings['hostSettingOverrides']
    agentSkillSharingEnabled?: GlobalSettings['agentSkillSharingEnabled']
    nativeChatSessionOptions?: GlobalSettings['nativeChatSessionOptions']
    nativeChatInlineVisuals?: GlobalSettings['nativeChatInlineVisuals']
    nativeChatInheritShellEnvironment?: GlobalSettings['nativeChatInheritShellEnvironment']
    nativeChatShellEnvironmentVariables?: GlobalSettings['nativeChatShellEnvironmentVariables']
    aiVaultSearch?: GlobalSettings['aiVaultSearch']
    sourceControlAi?: GlobalSettings['sourceControlAi']
    commitMessageAi?: GlobalSettings['commitMessageAi']
  }
  // Why: narrow to `unknown` return so test mocks can return void without
  // a cast. The runtime never reads the return value — the persisted value
  // is read back via getSettings() on the next access.
  updateSettings?: (
    updates: Partial<GlobalSettings>,
    options?: { notifyListeners?: boolean; originWebContentsId?: number }
  ) => unknown
  onSettingsChanged?: Store['onSettingsChanged']
}
