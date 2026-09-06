import { useState, useMemo } from 'react'
import { Keyboard } from 'react-native'
import { BottomDrawerModalHost } from './bottom-drawer-modal-host'
import { useNewWorktreeDrawerNavigation } from './use-new-worktree-drawer-navigation'
import { useRetiredWorktreeNames } from '../worktree/use-retired-worktree-names'
import { repoColor } from '../worktree/repo-color'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import {
  NEW_WORKTREE_AGENT_OPTIONS as AGENT_OPTIONS,
  NEW_WORKTREE_BLANK_AGENT as BLANK_TERMINAL,
  resolveNewWorktreeAgentSelection,
  type NewWorktreeAgentOption as AgentOption
} from './new-worktree-agent-selection'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import { deriveRepoSlug, type PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../src/shared/new-workspace/workspace-source'
import { getComposerRepoWorktreeBranches } from '../../../src/shared/composer-branch-selection'
import { useNewWorkspaceRepositories } from './use-new-workspace-repositories'
import { useNewWorkspaceRuntimeContext } from './use-new-workspace-runtime-context'
import { useNewWorkspaceExecutionTarget } from './use-new-workspace-execution-target'
import { useNewWorkspaceSetupScript } from './use-new-workspace-setup-script'
import { useNewWorkspaceCreation } from './use-new-workspace-creation'
import type {
  HostWorkspaceCreationOperations,
  NewWorkspaceRepository
} from '../worktree/host-workspace-creation-operations'
import type { HostScreenShellOperations } from '../worktree/host-screen-shell-operations'
import { NewWorktreeFormSheet } from './NewWorktreeFormSheet'
import { NewWorktreeModalDrawers } from './NewWorktreeModalDrawers'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

type Repo = NewWorkspaceRepository

function repoBadgeColor(repo: Repo | null): string {
  return repo?.badgeColor || repoColor(repo?.displayName ?? 'repository')
}

// ── Main modal ──────────────────────────────────────────────────────

type Props = {
  visible: boolean
  operations: HostWorkspaceCreationOperations | null
  hostId?: string
  // Why: existing worktree paths from the host so we can pick a unique
  // marine-creature default when the user leaves the name blank, matching
  // the desktop UI's behavior. The "already exists locally" collision is
  // on the on-disk directory basename, so paths (not displayNames) are
  // what the suggestion logic must dedupe against.
  existingWorktreePaths?: readonly string[]
  existingWorktrees?: readonly { repoId: string; branch: string }[]
  openExternalUrl: HostScreenShellOperations['openExternalUrl']
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}

export function NewWorktreeModal({
  visible,
  operations,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  openExternalUrl,
  onCreated,
  onClose
}: Props) {
  // Why: each drawer opening is a fresh form session; remounting resets local
  // form state before paint instead of clearing it in a visible-prop Effect.
  const [session, setSession] = useState({ openEpoch: 0, visible })
  if (session.visible !== visible) {
    setSession({
      openEpoch: visible ? session.openEpoch + 1 : session.openEpoch,
      visible
    })
  }

  return (
    <NewWorktreeModalContent
      key={`${session.openEpoch}:${hostId}`}
      visible={visible}
      operations={operations}
      hostId={hostId}
      existingWorktreePaths={existingWorktreePaths}
      existingWorktrees={existingWorktrees}
      openExternalUrl={openExternalUrl}
      onCreated={onCreated}
      onClose={onClose}
    />
  )
}

function NewWorktreeModalContent({
  visible,
  operations,
  hostId,
  existingWorktreePaths,
  existingWorktrees,
  openExternalUrl,
  onCreated,
  onClose
}: Props) {
  const { repos, selectedRepo, setSelectedRepo, loading } = useNewWorkspaceRepositories({
    operations,
    hostId,
    visible
  })
  // Why: a deleted workspace's directory can still hold agent conversation state keyed by cwd, so
  // its name must never be suggested again. Fetched per selected repo while the sheet is open.
  // Keyed on the path set rather than the array so a poll that changes nothing does not refetch.
  const retiredNamesRefreshKey = useMemo(
    () => [...(existingWorktreePaths ?? [])].sort().join('\0'),
    [existingWorktreePaths]
  )
  const readRetiredWorktreeNames = useMemo(
    () => (operations ? (repoId: string) => operations.readRetiredWorktreeNames(repoId) : null),
    [operations]
  )
  const retiredWorktreeNames = useRetiredWorktreeNames(
    readRetiredWorktreeNames,
    selectedRepo?.id,
    retiredNamesRefreshKey
  )
  const { drawerView, formSheetVisible, formSheetInteractive, transitionDrawer, openSourceDrawer } =
    useNewWorktreeDrawerNavigation(visible)
  const [selectedAgentState, setSelectedAgent] = useState<AgentOption>(AGENT_OPTIONS[0]!)
  const {
    runtimeSettings,
    setRuntimeSettings,
    trustedOrcaHooks,
    setTrustedOrcaHooks,
    availableProviders
  } = useNewWorkspaceRuntimeContext(operations, visible)
  const [agentOverriddenState, setAgentOverridden] = useState(false)
  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const {
    sshGate,
    detectedAgentIds,
    connect: connectSelectedSshRepo
  } = useNewWorkspaceExecutionTarget({
    operations,
    connectionId: selectedRepoConnectionId,
    visible
  })
  const [note, setNote] = useState('')
  const { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport } =
    useNewWorktreeRuntimeCapabilities(operations, visible)
  const {
    setupCommand,
    setupSource,
    setupTrust,
    setupRunPolicy,
    setupDecisionChoice,
    setSetupDecisionChoice,
    runSetup,
    setRunSetup,
    showAdvanced,
    setShowAdvanced
  } = useNewWorkspaceSetupScript({ operations, selectedRepo })
  const [error, setError] = useState('')
  const selectedRepoWorktreeBranches = useMemo(
    () => getComposerRepoWorktreeBranches(existingWorktrees ?? [], selectedRepo?.id ?? null),
    [existingWorktrees, selectedRepo]
  )

  const composer = useMobileComposerSource({
    operations,
    selectedRepoId: selectedRepo?.id ?? null,
    worktreeBranches: selectedRepoWorktreeBranches,
    onError: setError
  })

  const selectedAgentResolution = resolveNewWorktreeAgentSelection({
    visible,
    selectedAgent: selectedAgentState,
    agentOverridden: agentOverriddenState,
    runtimeSettings,
    detectedAgentIds
  })
  // Why: agent preference repair is pure render dataflow; doing it here
  // avoids a stale selected-agent commit while preserving user overrides.
  if (
    selectedAgentState.id !== selectedAgentResolution.selectedAgent.id ||
    agentOverriddenState !== selectedAgentResolution.agentOverridden
  ) {
    setSelectedAgent(selectedAgentResolution.selectedAgent)
    setAgentOverridden(selectedAgentResolution.agentOverridden)
  }
  const selectedAgent = selectedAgentResolution.selectedAgent

  const selectedRepoIsGit = selectedRepo ? selectedRepo.kind !== 'folder' : true
  const sourceAvailability: SmartModeAvailabilityInput = {
    textOnly: selectedRepo != null && !selectedRepoIsGit,
    tasksSupported,
    hasRepo: selectedRepo != null,
    githubAvailable: availableProviders.includes('github'),
    gitlabAvailable: availableProviders.includes('gitlab'),
    linearAvailable: availableProviders.includes('linear')
  }
  const pasteRepos = useMemo<PasteRepoCandidate[]>(
    () =>
      repos.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        slug: deriveRepoSlug(repo)
      })),
    [repos]
  )

  const creation = useNewWorkspaceCreation({
    operations,
    selectedRepo,
    sshRequiresConnection: sshGate.requiresConnection,
    runtimeSettings,
    setRuntimeSettings,
    selectedAgent,
    detectedAgentIds,
    setSelectedAgent,
    setAgentOverridden,
    composer,
    existingWorktreePaths,
    retiredWorktreeNames,
    setupCommand,
    setupRunPolicy,
    setupDecisionChoice,
    runSetup,
    setupTrust,
    trustedOrcaHooks,
    setTrustedOrcaHooks,
    transitionDrawer: (view) => transitionDrawer(view),
    getWorktreeCreateCutoverSupport,
    note,
    onClose,
    onCreated,
    setError
  })
  const {
    creating,
    setupTrustPrompt,
    handleCreate,
    approveSetupTrust,
    closeSetupTrust,
    skipSetupTrust
  } = creation

  const needsSetupChoice = Boolean(setupCommand) && setupRunPolicy === 'ask'
  const canCreate =
    selectedRepo != null &&
    !creating &&
    !sshGate.requiresConnection &&
    (!needsSetupChoice || setupDecisionChoice != null)
  const visibleAgentOptions =
    detectedAgentIds === null
      ? AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
      : AGENT_OPTIONS.filter(
          (agent) =>
            agent.id !== '__blank__' &&
            detectedAgentIds.has(agent.id) &&
            isMobileTuiAgentEnabled(agent.id, runtimeSettings?.disabledTuiAgents)
        )
  const pickerAgentOptions = [...visibleAgentOptions, BLANK_TERMINAL]
  const projectPickerItems = useMemo(() => buildNewWorkspaceProjectOptions(repos), [repos])
  const selectedProjectId = selectedRepo
    ? (selectedRepo.projectId ?? getProjectIdentityKey(selectedRepo))
    : null
  const selectedProject =
    projectPickerItems.find((project) => project.id === selectedProjectId) ?? null
  const runTargetPickerItems = useMemo(
    () => buildNewWorkspaceRunTargetOptions(repos, selectedProjectId, hostPlatform),
    [hostPlatform, repos, selectedProjectId]
  )
  const selectedRunTarget = selectedRepo
    ? getNewWorkspaceRunTarget(selectedRepo, hostPlatform)
    : null

  function prepareSelectionPickerOpen(): void {
    // Why: picker taps can beat an open soft keyboard; dismissing it prevents the
    // keyboard from reopening under the picker drawer.
    Keyboard.dismiss()
  }

  function handleRepoSelected(repo: Repo): void {
    const repoChanged = repo.id !== selectedRepo?.id
    setSelectedRepo(repo)
    // Branch and provider-backed sources are repo-scoped; Linear/Jira are global
    // work context and survive choosing a different implementation repo.
    if (repoChanged && !shouldPreserveWorkspaceSourceOnRepoChange(composer.linkedWorkItem)) {
      composer.handleClearSmartNameSelection()
    }
  }

  return (
    // Why: hosting the form and every picker in one persistent native Modal makes
    // form → repo/agent transitions in-window view swaps, avoiding the iOS
    // dismiss-then-present race that left the dropdowns unresponsive. Native back
    // closes the flow from the form, routes the trust prompt through its in-flight
    // guard, and otherwise returns to the form from a picker.
    <BottomDrawerModalHost
      visible={visible}
      onRequestClose={() => {
        if (drawerView === 'form') {
          onClose()
        } else if (drawerView === 'trust') {
          closeSetupTrust()
        } else {
          transitionDrawer('form')
        }
      }}
    >
      <NewWorktreeFormSheet
        visible={formSheetVisible}
        interactive={formSheetInteractive}
        loading={loading}
        hasRepos={repos.length > 0}
        project={selectedProject}
        runTarget={selectedRunTarget}
        projectBadgeColor={selectedRepo ? repoBadgeColor(selectedRepo) : null}
        selectedRepoIsGit={selectedRepoIsGit}
        selectedRepoConnectionId={selectedRepoConnectionId}
        selectedRepoName={selectedRepo?.displayName ?? 'Remote repository'}
        sshGate={sshGate}
        composer={composer}
        selectedAgent={selectedAgent}
        showAdvanced={showAdvanced}
        note={note}
        setupCommand={setupCommand}
        setupSource={setupSource}
        setupRunPolicy={setupRunPolicy}
        setupDecisionChoice={setupDecisionChoice}
        runSetup={runSetup}
        error={error}
        creating={creating}
        canCreate={canCreate}
        onClose={onClose}
        onOpenExternalUrl={openExternalUrl}
        onOpenProject={() => {
          prepareSelectionPickerOpen()
          transitionDrawer('project')
        }}
        onOpenRunTarget={() => {
          prepareSelectionPickerOpen()
          transitionDrawer('runTarget')
        }}
        onOpenSource={openSourceDrawer}
        onClearError={() => setError('')}
        onConnect={() => void connectSelectedSshRepo()}
        onOpenAgent={() => {
          prepareSelectionPickerOpen()
          transitionDrawer('agent')
        }}
        onShowAdvancedChange={setShowAdvanced}
        onNoteChange={setNote}
        onSetupDecisionChange={setSetupDecisionChoice}
        onRunSetupChange={setRunSetup}
        onCreate={() => void handleCreate()}
      />

      <NewWorktreeModalDrawers
        visible={visible}
        drawerView={drawerView}
        operations={operations}
        composer={composer}
        sourceAvailability={sourceAvailability}
        selectedRepo={selectedRepo}
        repos={repos}
        pasteRepos={pasteRepos}
        sshReady={!sshGate.requiresConnection}
        projectPickerItems={projectPickerItems}
        selectedProjectId={selectedProjectId}
        runTargetPickerItems={runTargetPickerItems}
        pickerAgentOptions={pickerAgentOptions}
        selectedAgent={selectedAgent}
        setupTrustPrompt={setupTrustPrompt}
        creating={creating}
        onSourceRepoChange={setSelectedRepo}
        onRepoChange={handleRepoSelected}
        onAgentChange={(agent) => {
          setAgentOverridden(true)
          setSelectedAgent(agent)
        }}
        onTransitionToForm={() => transitionDrawer('form')}
        onApproveSetupTrust={(alwaysTrust) => void approveSetupTrust(alwaysTrust)}
        onSkipSetupTrust={skipSetupTrust}
        onCloseSetupTrust={closeSetupTrust}
      />
    </BottomDrawerModalHost>
  )
}
