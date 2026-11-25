import { settingsRead } from '../../../settings/mobile-settings-read-operations'
import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import type { RetiredNameRegistry } from '../../../../../src/shared/worktree/naming/retired-name-registry'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { folderCreateBusyMessage, uncertainCreateMessage } from './new-workspace-create-copy'
import { triggerError, triggerSuccess } from '../../../platform/haptics/haptics'
import type { WorktreeCreateParent } from '../worktree-create-retry'
import { createBlankWorkspace } from '../blank-workspace-create'
import { isMobileTuiAgentEnabled } from '../../../agents/mobile-tui-agents'
import { createSetupNeedsTrustCheck, resolveCreateSetupApproval } from '../setup-hook-trust'
import {
  composerSetupHooksCreateSource,
  createWorkspaceFromComposerSource,
  resolveComposerSelectionBase,
  composerCreateRepoId
} from '../source-workspace-create'
import { createdSetupReviewPrompt } from '../created-worktree-setup-review'
import { saveStartupPolicy } from './setup-agent-startup-policy-save'
import {
  useNewWorkspaceSetupTrust,
  type CreateOptions,
  type SheetSetupTrustPrompt
} from './use-new-workspace-setup-trust'
import { normalizeWorkspaceAgent } from '../workspace-agent-selection'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../../src/shared/worktree/create-types'
import type { AgentLaunchSupport } from '../../../session/agent-launch/agent-launch-request'
import type { WorkspaceSshGate } from '../workspace-ssh-gate'
import type { useMobileComposerSource } from '../../source-selection/use-mobile-composer-source'
import type { WorktreeCreateIdempotencySupport } from '../worktree-create-idempotency-policy'
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
} from '../forms/new-worktree-modal-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../src/shared/execution-host/execution-host'
import { isRpcDeliveryUnknown } from '../../../transport/rpc/rpc-delivery-ambiguity'
import type { NewWorktreeDrawerView } from '../modal/use-new-worktree-drawer-navigation'
import { suggestCreatureNameForPaths as getSuggestedCreatureName } from '../../../../../src/shared/worktree/naming/worktree-name-suggestion'

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
  setupRunPolicy: SetupRunPolicy
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  setupWait: boolean | null
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
  setupTrustPrompt: SheetSetupTrustPrompt | null
  create: () => Promise<void>
  approveSetupTrust: (alwaysTrust: boolean) => Promise<void>
  closeSetupTrust: () => void
  skipSetupTrust: () => void
} {
  const createInFlightRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const setupTrust = useNewWorkspaceSetupTrust({
    ...args,
    createInFlight: () => createInFlightRef.current,
    setCreating,
    create: (options) => create(options),
    finishCreated: (created, notice) => {
      args.onClose()
      args.onCreated(
        created.worktreeId,
        created.name,
        [created.warning, notice].filter(Boolean).join(' ') || undefined
      )
    }
  })

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
      const composed = args.composer.createSelection
      // Resolve a PR/MR start point once, so the create checks out the source whose setup was shown.
      const selection =
        options.selection ??
        (composed && (await resolveComposerSelectionBase(client, composed, selectedRepo.id)))
      const createRepoId = composerCreateRepoId(selection, selectedRepo.id)
      // Setup is checked and shown for the repo the create lands in, which a work item may not share.
      const setupRepo =
        createRepoId === selectedRepo.id
          ? selectedRepo
          : args.repos.find((repo) => repo.id === createRepoId)
      if (!setupRepo) {
        args.setError("This item's project isn't available on this host.")
        return
      }
      let setupDecision: WorkspaceCreateSetupDecision = 'inherit'
      if (options.setupOverride) {
        setupDecision = options.setupOverride
      } else if (args.setupCommand) {
        if (args.setupRunPolicy === 'ask') {
          if (!args.setupDecisionChoice) {
            args.setError('Choose whether to run the setup script.')
            return
          }
          setupDecision = args.setupDecisionChoice
        } else {
          setupDecision = args.runSetup ? 'run' : 'skip'
        }
      }
      let setupApproval = options.setupApproval
      // The checkout may lack setup the created branch has, so check whenever setup isn't skipped.
      const needsTrustCheck = createSetupNeedsTrustCheck({
        sameRepo: setupRepo.id === selectedRepo.id,
        decision: setupDecision,
        runPolicy: args.setupRunPolicy
      })
      if (needsTrustCheck && !setupApproval) {
        const resolved = await resolveCreateSetupApproval({
          client,
          trust: args.trustedOrcaHooks,
          repos: args.repos,
          repo: setupRepo,
          createSource: selection ? composerSetupHooksCreateSource(selection) : { kind: 'base' }
        })
        if ('ask' in resolved) {
          setupTrust.ask({ ...resolved.ask, ...(selection ? { selection } : {}) })
          return
        }
        setupApproval = resolved.approved
      }
      if (!(await saveStartupPolicy(client, setupRepo, args.setupWait, args.setError))) {
        return
      }
      const createdWithAgentId =
        args.selectedAgent.id !== '__blank__' ? args.selectedAgent.id : undefined
      const trimmedNote = args.note.trim() || undefined
      const result = selection
        ? await createWorkspaceFromComposerSource({
            client,
            selection,
            targetRepoId: selectedRepo.id,
            setupDecision,
            approvedSetupHash: setupApproval?.approvedSetupHash,
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
            approvedSetupHash: setupApproval?.approvedSetupHash,
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
      const { setupTrustMismatch: mismatch, ...created } = result
      if (mismatch) {
        // The host skipped setup because the created branch's differs from what was approved.
        setupTrust.ask({
          ...createdSetupReviewPrompt({
            repo: setupRepo,
            repos: args.repos,
            trust: args.trustedOrcaHooks,
            mismatch
          }),
          created
        })
        return
      }
      args.onClose()
      args.onCreated(created.worktreeId, created.name, created.warning)
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

  return {
    creating,
    setupTrustPrompt: setupTrust.prompt,
    create,
    approveSetupTrust: setupTrust.approve,
    closeSetupTrust: setupTrust.close,
    skipSetupTrust: setupTrust.skip
  }
}
