import { useMemo, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { getComposerRepoWorktreeBranches } from '../../../src/shared/composer-branch-selection'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../src/shared/new-workspace/workspace-source'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import { deriveRepoSlug, type PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import {
  buildRetiredWorktreeNamesRefreshKey,
  useRetiredWorktreeNames
} from '../worktree/use-retired-worktree-names'
import { BottomDrawerModalHost } from './bottom-drawer-modal-host'
import {
  getMobileWorkspaceRepoBadgeColor,
  type MobileWorkspaceRepo,
  type NewWorktreeModalProps
} from './new-worktree-modal-types'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'
import { NewWorktreeFormSheet } from './NewWorktreeFormSheet'
import { NewWorktreeModalDrawers } from './NewWorktreeModalDrawers'
import { useNewWorkspaceAgentSelection } from './use-new-workspace-agent-selection'
import { useNewWorkspaceCreateSubmit } from './use-new-workspace-create-submit'
import { useNewWorkspaceExecutionTarget } from './use-new-workspace-execution-target'
import { useNewWorkspaceRepositories } from './use-new-workspace-repositories'
import { useNewWorkspaceRuntimeContext } from './use-new-workspace-runtime-context'
import { useNewWorkspaceSetupScript } from './use-new-workspace-setup-script'
import { useNewWorktreeDrawerNavigation } from './use-new-worktree-drawer-navigation'

export function NewWorktreeModal(props: NewWorktreeModalProps) {
  const openEpochRef = useRef(0)
  const wasVisibleRef = useRef(false)
  const clientEpochRef = useRef({ client: props.client, epoch: 0 })

  // Why: each drawer opening is a fresh form session; remounting resets local
  // form state before paint instead of clearing it in a visible-prop Effect.
  if (props.visible && !wasVisibleRef.current) {
    openEpochRef.current += 1
  }
  wasVisibleRef.current = props.visible
  if (clientEpochRef.current.client !== props.client) {
    clientEpochRef.current = { client: props.client, epoch: clientEpochRef.current.epoch + 1 }
  }

  return (
    <NewWorktreeModalContent
      key={`${openEpochRef.current}:${clientEpochRef.current.epoch}`}
      {...props}
    />
  )
}

function NewWorktreeModalContent(props: NewWorktreeModalProps) {
  const { visible, client, hostId, existingWorktreePaths, existingWorktrees, onCreated, onClose } =
    props
  const { repos, selectedRepo, setSelectedRepo, loading } = useNewWorkspaceRepositories({
    client,
    hostId,
    visible
  })
  const navigation = useNewWorktreeDrawerNavigation(visible)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const runtime = useNewWorkspaceRuntimeContext(client, visible, hostId)
  const { tasksSupported, hostPlatform, getWorktreeCreateCutoverSupport } =
    useNewWorktreeRuntimeCapabilities(client, visible)
  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const executionTarget = useNewWorkspaceExecutionTarget({
    client,
    connectionId: selectedRepoConnectionId,
    visible
  })
  const setupScript = useNewWorkspaceSetupScript({ client, selectedRepo })
  const selectedRepoWorktreeBranches = useMemo(
    () => getComposerRepoWorktreeBranches(existingWorktrees ?? [], selectedRepo?.id ?? null),
    [existingWorktrees, selectedRepo]
  )
  const composer = useMobileComposerSource({
    client,
    selectedRepoId: selectedRepo?.id ?? null,
    worktreeBranches: selectedRepoWorktreeBranches,
    onError: setError
  })
  const agentSelection = useNewWorkspaceAgentSelection({
    visible,
    runtimeSettings: runtime.runtimeSettings,
    detectedAgentIds: executionTarget.detectedAgentIds
  })
  const retiredNamesRefreshKey = useMemo(
    () => buildRetiredWorktreeNamesRefreshKey(existingWorktreePaths),
    [existingWorktreePaths]
  )
  const retiredWorktreeNames = useRetiredWorktreeNames(
    client,
    selectedRepo?.id,
    retiredNamesRefreshKey
  )
  const createSubmit = useNewWorkspaceCreateSubmit({
    client,
    selectedRepo,
    selectedAgent: agentSelection.selectedAgent,
    setSelectedAgent: agentSelection.setSelectedAgent,
    setAgentOverridden: agentSelection.setAgentOverridden,
    runtimeSettings: runtime.runtimeSettings,
    setRuntimeSettings: runtime.setRuntimeSettings,
    detectedAgentIds: executionTarget.detectedAgentIds,
    sshGate: executionTarget.sshGate,
    composer,
    note,
    existingWorktreePaths,
    retiredWorktreeNames,
    setupCommand: setupScript.setupCommand,
    setupTrust: setupScript.setupTrust,
    setupRunPolicy: setupScript.setupRunPolicy,
    setupDecisionChoice: setupScript.setupDecisionChoice,
    runSetup: setupScript.runSetup,
    trustedOrcaHooks: runtime.trustedOrcaHooks,
    setTrustedOrcaHooks: runtime.setTrustedOrcaHooks,
    getWorktreeCreateCutoverSupport,
    transitionDrawer: navigation.transitionDrawer,
    setError,
    onCreated,
    onClose
  })

  const selectedRepoIsGit = selectedRepo ? selectedRepo.kind !== 'folder' : true
  const sourceAvailability: SmartModeAvailabilityInput = {
    textOnly: selectedRepo != null && !selectedRepoIsGit,
    tasksSupported,
    hasRepo: selectedRepo != null,
    githubAvailable: runtime.availableProviders.includes('github'),
    gitlabAvailable: runtime.availableProviders.includes('gitlab'),
    linearAvailable: runtime.availableProviders.includes('linear')
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
  const projectPickerItems = useMemo(() => buildNewWorkspaceProjectOptions(repos), [repos])
  const selectedProjectId = selectedRepo ? getProjectIdentityKey(selectedRepo) : null
  const selectedProject =
    projectPickerItems.find((project) => project.id === selectedProjectId) ?? null
  const runTargetPickerItems = useMemo(
    () => buildNewWorkspaceRunTargetOptions(repos, selectedProjectId, hostPlatform),
    [hostPlatform, repos, selectedProjectId]
  )
  const selectedRunTarget = selectedRepo
    ? getNewWorkspaceRunTarget(selectedRepo, hostPlatform)
    : null
  const needsSetupChoice = Boolean(setupScript.setupCommand) && setupScript.setupRunPolicy === 'ask'
  const canCreate =
    selectedRepo != null &&
    !createSubmit.creating &&
    !executionTarget.sshGate.requiresConnection &&
    (!needsSetupChoice || setupScript.setupDecisionChoice != null)

  function openPicker(view: 'project' | 'runTarget' | 'agent'): void {
    Keyboard.dismiss()
    navigation.transitionDrawer(view)
  }

  function selectRepo(repo: MobileWorkspaceRepo, clearRepoScopedSource: boolean): void {
    const repoChanged = repo.id !== selectedRepo?.id
    setSelectedRepo(repo)
    if (
      clearRepoScopedSource &&
      repoChanged &&
      !shouldPreserveWorkspaceSourceOnRepoChange(composer.linkedWorkItem)
    ) {
      composer.handleClearSmartNameSelection()
    }
  }

  function requestClose(): void {
    if (navigation.drawerView === 'form') {
      onClose()
    } else if (navigation.drawerView === 'trust') {
      createSubmit.closeSetupTrust()
    } else {
      navigation.transitionDrawer('form')
    }
  }

  return (
    <BottomDrawerModalHost visible={visible} onRequestClose={requestClose}>
      <NewWorktreeFormSheet
        visible={navigation.formSheetVisible}
        interactive={navigation.formSheetInteractive}
        loading={loading}
        hasRepos={repos.length > 0}
        project={selectedProject}
        runTarget={selectedRunTarget}
        projectBadgeColor={selectedRepo ? getMobileWorkspaceRepoBadgeColor(selectedRepo) : null}
        selectedRepoIsGit={selectedRepoIsGit}
        selectedRepoConnectionId={selectedRepoConnectionId}
        selectedRepoName={selectedRepo?.displayName ?? 'Remote repository'}
        sshGate={executionTarget.sshGate}
        composer={composer}
        selectedAgent={agentSelection.selectedAgent}
        showAdvanced={setupScript.showAdvanced}
        note={note}
        setupCommand={setupScript.setupCommand}
        setupSource={setupScript.setupSource}
        setupRunPolicy={setupScript.setupRunPolicy}
        setupDecisionChoice={setupScript.setupDecisionChoice}
        runSetup={setupScript.runSetup}
        error={error}
        creating={createSubmit.creating}
        canCreate={canCreate}
        onClose={onClose}
        onOpenProject={() => openPicker('project')}
        onOpenRunTarget={() => openPicker('runTarget')}
        onOpenSource={navigation.openSourceDrawer}
        onClearError={() => setError('')}
        onConnect={() => void executionTarget.connect()}
        onOpenAgent={() => openPicker('agent')}
        onShowAdvancedChange={setupScript.setShowAdvanced}
        onNoteChange={setNote}
        onSetupDecisionChange={setupScript.setSetupDecisionChoice}
        onRunSetupChange={setupScript.setRunSetup}
        onCreate={() => void createSubmit.create()}
      />

      <NewWorktreeModalDrawers
        visible={visible}
        drawerView={navigation.drawerView}
        client={client}
        composer={composer}
        sourceAvailability={sourceAvailability}
        selectedRepo={selectedRepo}
        repos={repos}
        pasteRepos={pasteRepos}
        sshReady={!executionTarget.sshGate.requiresConnection}
        projectPickerItems={projectPickerItems}
        selectedProjectId={selectedProjectId}
        runTargetPickerItems={runTargetPickerItems}
        pickerAgentOptions={agentSelection.pickerAgentOptions}
        selectedAgent={agentSelection.selectedAgent}
        setupTrustPrompt={createSubmit.setupTrustPrompt}
        creating={createSubmit.creating}
        onSourceRepoChange={(repo) => selectRepo(repo, false)}
        onRepoChange={(repo) => selectRepo(repo, true)}
        onAgentChange={(agent) => {
          agentSelection.setAgentOverridden(true)
          agentSelection.setSelectedAgent(agent)
        }}
        onTransitionToForm={() => navigation.transitionDrawer('form')}
        onApproveSetupTrust={(alwaysTrust) => void createSubmit.approveSetupTrust(alwaysTrust)}
        onSkipSetupTrust={createSubmit.skipSetupTrust}
        onCloseSetupTrust={createSubmit.closeSetupTrust}
      />
    </BottomDrawerModalHost>
  )
}
