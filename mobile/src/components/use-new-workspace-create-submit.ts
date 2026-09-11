import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { createBlankWorkspace } from '../tasks/blank-workspace-create'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import {
  isSetupHookTrusted,
  persistSetupHookTrustApproval,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../tasks/setup-hook-trust'
import { createWorkspaceFromComposerSource } from '../tasks/source-workspace-create'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { WorkspaceSshGate } from '../tasks/workspace-ssh-gate'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import type { WorktreeCreateIdempotencySupport } from '../tasks/worktree-create-idempotency-policy'
import {
  pickPreferredNewWorktreeAgent,
  type NewWorktreeAgentOption,
  type NewWorktreeRuntimeSettings
} from './new-worktree-agent-selection'
import type { MobileWorkspaceRepo, SetupRunPolicy } from './new-worktree-modal-types'
import type { SetupTrustPrompt } from './SetupHookTrustDrawer'
import type { NewWorktreeDrawerView } from './use-new-worktree-drawer-navigation'
import { getSuggestedCreatureName } from './worktree-name-suggestion'

type CreateOptions = {
  setupOverride?: Exclude<WorkspaceCreateSetupDecision, 'inherit'>
  approvedSetupContentHash?: string
}

type Composer = ReturnType<typeof useMobileComposerSource>

export function useNewWorkspaceCreateSubmit(args: {
  client: RpcClient | null
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
  transitionDrawer: (view: Exclude<NewWorktreeDrawerView, 'transition'>) => void
  setError: Dispatch<SetStateAction<string>>
  onCreated: (worktreeId: string, name: string) => void
  onClose: () => void
}): {
  creating: boolean
  setupTrustPrompt: SetupTrustPrompt | null
  create: () => Promise<void>
  approveSetupTrust: (alwaysTrust: boolean) => Promise<void>
  closeSetupTrust: () => void
  skipSetupTrust: () => void
} {
  const createInFlightRef = useRef(false)
  const setupTrustActionInFlightRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<SetupTrustPrompt | null>(null)

  async function create(options: CreateOptions = {}): Promise<void> {
    const { client, selectedRepo } = args
    if (!client || !selectedRepo || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    args.setError('')
    try {
      if (args.sshGate.requiresConnection) {
        args.setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      let latestRuntimeSettings = args.runtimeSettings
      try {
        const settingsResponse = await client.sendRequest('settings.get')
        if (settingsResponse.ok) {
          const result = (settingsResponse as RpcSuccess).result as {
            settings: NewWorktreeRuntimeSettings
          }
          latestRuntimeSettings = result.settings
          args.setRuntimeSettings(result.settings)
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
        !isSetupHookTrusted(args.trustedOrcaHooks, selectedRepo.id, args.setupTrust.contentHash)
      ) {
        setSetupTrustPrompt({
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
            worktreeCreateIdempotency: args.getWorktreeCreateCutoverSupport()
          })
        : await createBlankWorkspace({
            client,
            repoId: selectedRepo.id,
            baseName,
            nameWasGenerated: !trimmedName,
            createdWithAgentId,
            comment: trimmedNote,
            setupDecision,
            worktreeCreateIdempotency: args.getWorktreeCreateCutoverSupport()
          })
      if ('error' in result) {
        args.setError(result.error)
        return
      }
      args.onClose()
      args.onCreated(result.worktreeId, result.name)
    } catch (error) {
      args.setError(error instanceof Error ? error.message : 'Failed to create workspace')
    } finally {
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
