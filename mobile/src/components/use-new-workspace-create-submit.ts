import { settingsRead } from '../settings/mobile-settings-read-operations'
import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { folderCreateBusyMessage, uncertainCreateMessage } from './new-workspace-create-copy'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import type { WorktreeCreateParent } from '../new-workspace/creation/worktree-create-retry'
import { createBlankWorkspace } from '../new-workspace/creation/blank-workspace-create'
import { isMobileTuiAgentEnabled } from '../agents/mobile-tui-agents'
import {
  isSetupHookTrusted,
  persistSetupHookTrustApproval,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../new-workspace/creation/setup-hook-trust'
import { createWorkspaceFromComposerSource } from '../new-workspace/creation/source-workspace-create'
import { normalizeWorkspaceAgent } from '../new-workspace/creation/workspace-agent-selection'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../src/shared/worktree/create-types'
import type { AgentLaunchSupport } from '../session/agent-launch/agent-launch-request'
import type { WorkspaceSshGate } from '../new-workspace/creation/workspace-ssh-gate'
import type { useMobileComposerSource } from '../new-workspace/source-selection/use-mobile-composer-source'
import type { WorktreeCreateIdempotencySupport } from '../new-workspace/creation/worktree-create-idempotency-policy'
import {
  pickPreferredNewWorktreeAgent,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'
import type {
  MobileWorkspaceRepo,
  NewWorktreeFolderSubmission,
  NewWorktreeFolderSubmit,
  SetupRunPolicy
} from './new-worktree-modal-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import { isRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import type { OrcaHookTrustPrompt } from './OrcaHookTrustDrawer'
import type { NewWorktreeDrawerView } from './use-new-worktree-drawer-navigation'
import { getSuggestedCreatureName } from './worktree-name-suggestion'

type CreateOptions = {
  setupOverride?: Exclude<WorkspaceCreateSetupDecision, 'inherit'>
  approvedSetupContentHash?: string
}

type Composer = ReturnType<typeof useMobileComposerSource>

export function useNewWorkspaceCreateSubmit(args: {
  client: RpcClient | null
  repos: readonly MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  selectedAgent: NewWorktreeAgentOption
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  runtimeSettings: NewWorktreeRuntimeSettings | null
  setRuntimeSettings: (settings: NewWorktreeRuntimeSettings) => void
  detectedAgentIds: Set<string> | null
  sshGate: WorkspaceSshGate
  composer: Composer
  note: string
  existingWorktreePaths?: readonly string[]
  retiredWorktreeNames: RetiredNameRegistry
  setupCommand: string | null
  setupTrust: SetupHookTrust | null
  setupRunPolicy: SetupRunPolicy
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  setTrustedOrcaHooks: (trust: PersistedTrustedOrcaHooks) => void
  getWorktreeCreateCutoverSupport: () => Promise<WorktreeCreateIdempotencySupport | false>
  getAgentLaunchSupport: () => Promise<AgentLaunchSupport | false>
  getBranchIntentSupport: (intent: 'open-existing-v2' | 'create-new') => Promise<boolean>
  transitionDrawer: (view: Exclude<NewWorktreeDrawerView, 'transition'>) => void
  setError: Dispatch<SetStateAction<string>>
  onCreated: (worktreeId: string, name: string, warning?: string) => void
  onClose: () => void
  /** Opened from a folder: creates on that folder's host, attached to it, owned by the folder screen. */
  folderLaunch?: NewWorktreeFolderSubmit & {
    executionHostId: ExecutionHostId
    parent: WorktreeCreateParent
  }
}): {
  creating: boolean
  setupTrustPrompt: OrcaHookTrustPrompt | null
  create: () => Promise<void>
  approveSetupTrust: (alwaysTrust: boolean) => Promise<void>
  closeSetupTrust: () => void
  skipSetupTrust: () => void
} {
  const createInFlightRef = useRef(false)
  const setupTrustActionInFlightRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<OrcaHookTrustPrompt | null>(null)

  async function create(options: CreateOptions = {}): Promise<void> {
    const { client, selectedRepo } = args
    if (!client || !selectedRepo || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    args.setError('')
    const folder = args.folderLaunch
    // Admitted for the repo actually picked, before anything is sent; the folder screen owns it until it settles.
    const admission = folder
      ? getRepoExecutionHostId(selectedRepo) === folder.executionHostId
        ? folder.begin(selectedRepo)
        : null
      : undefined
    const presenting = (): boolean => folder?.presenting() ?? true
    let outcome: Parameters<NewWorktreeFolderSubmission['settle']>[0] = 'cancelled'
    try {
      if (admission === null) {
        args.setError(folderCreateBusyMessage())
        return
      }
      if (args.sshGate.requiresConnection) {
        args.setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      let latestRuntimeSettings = args.runtimeSettings
      try {
        const settingsReply = await settingsRead.request(client)
        const settings = settingsRead.interpret(settingsReply)
        if (settings.accepted) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          latestRuntimeSettings = settings.value as NewWorktreeRuntimeSettings
          args.setRuntimeSettings(latestRuntimeSettings)
        }
      } catch {
        // The runtime validates the same setting before spawning.
      }
      if (
        args.selectedAgent.id !== '__blank__' &&
        !isMobileTuiAgentEnabled(args.selectedAgent.id, latestRuntimeSettings?.disabledTuiAgents)
      ) {
        args.setSelectedAgent(
          pickPreferredNewWorktreeAgent(latestRuntimeSettings, args.detectedAgentIds)
        )
        args.setAgentOverridden(false)
        args.setError('Selected agent is disabled. Choose an enabled agent before creating.')
        return
      }

      const trimmedName = args.composer.name.trim()
      const baseName =
        trimmedName ||
        getSuggestedCreatureName(
          args.existingWorktreePaths ?? [],
          undefined,
          args.retiredWorktreeNames
        )
      let setupDecision: WorkspaceCreateSetupDecision = 'inherit'
      if (args.setupCommand) {
        if (options.setupOverride) {
          setupDecision = options.setupOverride
        } else if (args.setupRunPolicy === 'ask') {
          if (!args.setupDecisionChoice) {
            args.setError('Choose whether to run the setup script.')
            return
          }
          setupDecision = args.setupDecisionChoice
        } else {
          setupDecision = args.runSetup ? 'run' : 'skip'
        }
      }
      if (
        setupDecision === 'run' &&
        args.setupTrust &&
        args.setupTrust.contentHash !== options.approvedSetupContentHash &&
        !isSetupHookTrusted(
          args.trustedOrcaHooks,
          args.repos,
          selectedRepo.id,
          args.setupTrust.contentHash
        )
      ) {
        setSetupTrustPrompt({
          kind: 'setup',
          repoId: selectedRepo.id,
          repoName: selectedRepo.displayName,
          scriptContent: args.setupTrust.scriptContent,
          contentHash: args.setupTrust.contentHash,
          previouslyApproved: wasSetupHookPreviouslyApproved(args.trustedOrcaHooks, selectedRepo.id)
        })
        args.transitionDrawer('trust')
        return
      }

      const createdWithAgentId =
        args.selectedAgent.id !== '__blank__' ? args.selectedAgent.id : undefined
      const trimmedNote = args.note.trim() || undefined
      const selection = args.composer.createSelection
      const result = selection
        ? await createWorkspaceFromComposerSource({
            client,
            selection,
            targetRepoId: selectedRepo.id,
            setupDecision,
            agent: { choice: normalizeWorkspaceAgent(args.selectedAgent.id) ?? 'blank' },
            workspaceName: trimmedName || undefined,
            note: trimmedNote,
            nameIsAutoManaged: args.composer.isNameAutoManaged,
            worktreeCreateIdempotency: args.getWorktreeCreateCutoverSupport(),
            agentLaunchSupported: args.getAgentLaunchSupport(),
            branchIntentSupported: args.getBranchIntentSupport(
              selection.kind === 'branch' && selection.reuse ? 'open-existing-v2' : 'create-new'
            ),
            parent: folder?.parent
          })
        : await createBlankWorkspace({
            client,
            repoId: selectedRepo.id,
            baseName,
            nameWasGenerated: !trimmedName,
            createdWithAgentId,
            comment: trimmedNote,
            setupDecision,
            worktreeCreateIdempotency: args.getWorktreeCreateCutoverSupport(),
            agentLaunchSupported: args.getAgentLaunchSupport(),
            parent: folder?.parent
          })
      if ('error' in result) {
        // Refused on a resend after a lost reply: the first send may have created it.
        outcome = result.replayed ? 'uncertain' : 'failed'
        if (outcome === 'uncertain') {
          // Not a failure to retry: creating again could make a second one.
          args.setError(uncertainCreateMessage(folder !== undefined))
          return
        }
        if (presenting()) {
          triggerError()
        }
        args.setError(result.error)
        return
      }
      outcome = 'created'
      if (presenting()) {
        triggerSuccess()
      }
      args.onClose()
      args.onCreated(result.worktreeId, result.name, result.warning)
    } catch (error) {
      // A lost reply may still have created it.
      outcome = isRpcDeliveryUnknown(error) ? 'uncertain' : 'failed'
      if (folder && outcome === 'uncertain') {
        // The folder screen refreshes and holds it until its list shows it; sending again could create a second one.
        args.setError(uncertainCreateMessage(true))
        return
      }
      if (presenting()) {
        triggerError()
      }
      args.setError(error instanceof Error ? error.message : 'Failed to create workspace')
    } finally {
      admission?.settle(outcome)
      createInFlightRef.current = false
      setCreating(false)
    }
  }

  async function approveSetupTrust(alwaysTrust: boolean): Promise<void> {
    if (
      !args.client ||
      !setupTrustPrompt ||
      setupTrustActionInFlightRef.current ||
      createInFlightRef.current
    ) {
      return
    }
    setupTrustActionInFlightRef.current = true
    setCreating(true)
    try {
      const nextTrust = await persistSetupHookTrustApproval({
        client: args.client,
        trust: args.trustedOrcaHooks,
        repoId: setupTrustPrompt.repoId,
        contentHash: setupTrustPrompt.contentHash,
        alwaysTrust
      })
      args.setTrustedOrcaHooks(nextTrust)
      const approvedHash = setupTrustPrompt.contentHash
      setSetupTrustPrompt(null)
      args.transitionDrawer('form')
      await create({ setupOverride: 'run', approvedSetupContentHash: approvedHash })
    } catch (error) {
      args.setError(error instanceof Error ? error.message : 'Failed to trust setup script.')
    } finally {
      setupTrustActionInFlightRef.current = false
      if (!createInFlightRef.current) {
        setCreating(false)
      }
    }
  }

  function closeSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    setSetupTrustPrompt(null)
    args.transitionDrawer('form')
  }

  function skipSetupTrust(): void {
    if (setupTrustActionInFlightRef.current || createInFlightRef.current) {
      return
    }
    closeSetupTrust()
    void create({ setupOverride: 'skip' })
  }

  return { creating, setupTrustPrompt, create, approveSetupTrust, closeSetupTrust, skipSetupTrust }
}
