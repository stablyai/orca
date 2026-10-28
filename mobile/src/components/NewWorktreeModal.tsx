import { useMemo, useState } from 'react'
import { Keyboard } from 'react-native'
import { getComposerRepoWorktreeBranches } from '../../../src/shared/composer-branch-selection'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../src/shared/execution-host'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import { shouldPreserveWorkspaceSourceOnRepoChange } from '../../../src/shared/new-workspace/workspace-source'
import type { SmartModeAvailabilityInput } from '../tasks/mobile-smart-source-modes'
import { deriveRepoSlug, type PasteRepoCandidate } from '../tasks/smart-source-paste-intent'
import { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import { useNewWorktreeRuntimeCapabilities } from '../tasks/worktree-create-capability'
import { useWorktreeCreateBasePrefetch } from '../tasks/use-worktree-create-base-prefetch'
import { useHostDescriptor } from '../transport/host-descriptor-store'
import { isSameMobileWorkspaceRepo } from '../worktree/new-workspace-dialog-repo-selection'
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

/** The server a repo runs on; undefined for the desktop's own (local, SSH, folder). */
function serverOf(repo: MobileWorkspaceRepo): `runtime:${string}` | undefined {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime' ? host.id : undefined
}

export function NewWorktreeModal(props: NewWorktreeModalProps) {
  // Remount fresh form before paint per committed opening. Use state, not render-mutated ref counter: react-freeze may discard opening renders.
  const [session, setSession] = useState({ openEpoch: 0, visible: props.visible })
  if (session.visible !== props.visible) {
    setSession({
      openEpoch: props.visible ? session.openEpoch + 1 : session.openEpoch,
      visible: props.visible
    })
  }

  // Key by host, not client: reconnect swaps RpcClient without ending form session and must not erase picked source. Client-scoped hooks discard superseded responses.
  return <NewWorktreeModalContent key={`${session.openEpoch}:${props.hostId}`} {...props} />
}

function NewWorktreeModalContent(props: NewWorktreeModalProps) {
  const {
    visible,
    client: desktopClient,
    serverClients,
    hostId,
    hostLabelById,
    existingWorktreePaths,
    existingWorktrees,
    openExternalUrl,
    onCreated,
    onClose
  } = props
  const { repos, allRepos, selectedRepo, setSelectedRepo, loading } = useNewWorkspaceRepositories({
    client: desktopClient,
    serverClients,
    hostId,
    visible
  })
  // Route picked-repo operations to its host; desktop settings/accounts stay on desktop.
  const repoServer = selectedRepo ? serverOf(selectedRepo) : undefined
  const client = repoServer ? (serverClients?.get(repoServer) ?? null) : desktopClient
  const navigation = useNewWorktreeDrawerNavigation(visible)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const runtime = useNewWorkspaceRuntimeContext(client, visible, hostId)
  const repoRuntime = useNewWorktreeRuntimeCapabilities(client, visible)
  const { tasksSupported, getWorktreeCreateCutoverSupport, getAgentLaunchSupport } = repoRuntime
  // The desktop's own run target is named for the desktop, whichever host the picked repo is on.
  const desktopPlatform = useHostDescriptor(hostId)?.platform ?? null
  const hostPlatform = repoServer ? desktopPlatform : repoRuntime.hostPlatform
  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null
  const executionTarget = useNewWorkspaceExecutionTarget({
    client,
    connectionId: selectedRepoConnectionId,
    repoId: selectedRepo?.id,
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
  const selectedRepoIsGit = selectedRepo ? selectedRepo.kind !== 'folder' : true
  useWorktreeCreateBasePrefetch({
    client: visible ? client : null,
    repoId: selectedRepo?.id ?? null,
    repoIsGit: selectedRepoIsGit,
    selection: composer.createSelection
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
    repos: allRepos,
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
    getAgentLaunchSupport,
    transitionDrawer: navigation.transitionDrawer,
    setError,
    onCreated: (worktreeId, name, warning) => onCreated(worktreeId, name, warning, repoServer),
    onClose
  })

  const sourceAvailability: SmartModeAvailabilityInput = {
    textOnly: selectedRepo != null && !selectedRepoIsGit,
    tasksSupported,
    hasRepo: selectedRepo != null,
    githubAvailable: runtime.availableProviders.includes('github'),
    gitlabAvailable: runtime.availableProviders.includes('gitlab'),
    linearAvailable: runtime.availableProviders.includes('linear'),
    jiraAvailable: runtime.jiraConnection.connected && runtime.availableProviders.includes('jira')
  }
  // Why one client's: a source's repo switch is looked up through the picked repo's client.
  const hostRepos = useMemo(
    () => repos.filter((repo) => serverOf(repo) === repoServer),
    [repoServer, repos]
  )
  const pasteRepos = useMemo<PasteRepoCandidate[]>(
    () =>
      hostRepos.map((repo) => ({
        id: repo.id,
        displayName: repo.displayName,
        slug: deriveRepoSlug(repo)
      })),
    [hostRepos]
  )
  const projectPickerItems = useMemo(() => buildNewWorkspaceProjectOptions(repos), [repos])
  const selectedProjectId = selectedRepo ? getProjectIdentityKey(selectedRepo) : null
  const selectedProject =
    projectPickerItems.find((project) => project.id === selectedProjectId) ?? null
  const runTargetPickerItems = useMemo(
    () => buildNewWorkspaceRunTargetOptions(repos, selectedProjectId, hostPlatform, hostLabelById),
    [hostLabelById, hostPlatform, repos, selectedProjectId]
  )
  const selectedRunTarget = selectedRepo
    ? getNewWorkspaceRunTarget(selectedRepo, hostPlatform, hostLabelById)
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
    const repoChanged = !selectedRepo || !isSameMobileWorkspaceRepo(repo, selectedRepo)
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
        onOpenExternalUrl={openExternalUrl}
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
        repos={hostRepos}
        pasteRepos={pasteRepos}
        jiraSiteId={runtime.jiraConnection.selection}
        jiraSites={runtime.jiraConnection.sites}
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
