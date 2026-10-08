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
  // Why: each drawer opening is a fresh form session; remounting resets local
  // form state before paint instead of clearing it in a visible-prop Effect.
  // State, not a ref: react-native-screens freezes a blurred screen by suspending
  // this subtree, and a counter bumped during a render React then throws away
  // would restart the session for an opening that never committed.
  const [session, setSession] = useState({ openEpoch: 0, visible: props.visible })
  if (session.visible !== props.visible) {
    setSession({
      openEpoch: props.visible ? session.openEpoch + 1 : session.openEpoch,
      visible: props.visible
    })
  }

  // Why: key the session on the HOST, never on the RpcClient object. A reconnect,
  // forceReconnect, or foreground revival swaps that object for the same host
  // (see useHostClient), and keying on it silently remounted this form mid-edit
  // and threw away the picked source. Every client-scoped hook below already
  // drops responses from a superseded client, so no remount is needed for that.
  return <NewWorktreeModalContent key={`${session.openEpoch}:${props.hostId}`} {...props} />
}

function NewWorktreeModalContent(props: NewWorktreeModalProps) {
  const {
    visible,
    client: desktopClient,
    serverClients,
    hostId,
    existingWorktreePaths,
    existingWorktrees,
    openExternalUrl,
    onCreated,
    onClose
  } = props
  const { repos, selectedRepo, setSelectedRepo, loading } = useNewWorkspaceRepositories({
    client: desktopClient,
    serverClients,
    hostId,
    visible
  })
  // Why: everything about the picked repo runs where it does; the routing table keeps the
  // desktop's own concerns (settings, accounts) on the desktop.
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
    getAgentLaunchSupport,
    transitionDrawer: navigation.transitionDrawer,
    setError,
    onCreated: (worktreeId, name, warning) => onCreated(worktreeId, name, warning, repoServer),
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
