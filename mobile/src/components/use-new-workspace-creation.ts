import { useRef, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import { getSuggestedCreatureName } from './worktree-name-suggestion'
import {
  isSetupHookTrusted,
  wasSetupHookPreviouslyApproved,
  type SetupHookTrust
} from '../tasks/setup-hook-trust'
import { isMobileTuiAgentEnabled } from '../tasks/mobile-tui-agents'
import { normalizeWorkspaceAgent } from '../tasks/workspace-agent-selection'
import type {
  HostWorkspaceCreationOperations,
  NewWorkspaceRepository,
  NewWorkspaceRuntimeSettings
} from '../worktree/host-workspace-creation-operations'
import type { RetiredNameRegistry } from '../../../src/shared/worktree/retired-name-registry'
import type { useMobileComposerSource } from '../tasks/use-mobile-composer-source'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import {
  pickPreferredNewWorktreeAgent,
  type NewWorktreeAgentOption
} from './new-worktree-agent-selection'
import type { SetupTrustPrompt } from './SetupHookTrustDrawer'

type Composer = ReturnType<typeof useMobileComposerSource>
type SetupDecision = WorkspaceCreateSetupDecision
type CreateOptions = {
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  approvedSetupContentHash?: string
}

export function useNewWorkspaceCreation(args: {
  operations: HostWorkspaceCreationOperations | null
  selectedRepo: NewWorkspaceRepository | null
  sshRequiresConnection: boolean
  runtimeSettings: NewWorkspaceRuntimeSettings | null
  setRuntimeSettings: (settings: NewWorkspaceRuntimeSettings) => void
  selectedAgent: NewWorktreeAgentOption
  detectedAgentIds: Set<string> | null
  setSelectedAgent: (agent: NewWorktreeAgentOption) => void
  setAgentOverridden: (overridden: boolean) => void
  composer: Composer
  existingWorktreePaths?: readonly string[]
  retiredWorktreeNames: RetiredNameRegistry | null
  setupCommand: string | null
  setupRunPolicy: 'ask' | 'run-by-default' | 'skip-by-default'
  setupDecisionChoice: Exclude<SetupDecision, 'inherit'> | null
  runSetup: boolean
  setupTrust: SetupHookTrust | null
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  setTrustedOrcaHooks: (trust: PersistedTrustedOrcaHooks) => void
  transitionDrawer: (view: 'form' | 'trust') => void
  getWorktreeCreateCutoverSupport: () => Parameters<
    HostWorkspaceCreationOperations['createBlankWorkspace']
  >[0]['worktreeCreateIdempotency']
  note: string
  onClose: () => void
  onCreated: (worktreeId: string, name: string) => void
  setError: (error: string) => void
}) {
  const createInFlightRef = useRef(false)
  const setupTrustActionInFlightRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const [setupTrustPrompt, setSetupTrustPrompt] = useState<SetupTrustPrompt | null>(null)

  async function handleCreate(options: CreateOptions = {}): Promise<void> {
    const { operations, selectedRepo } = args
    if (!operations || !selectedRepo || createInFlightRef.current) {
      return
    }
    createInFlightRef.current = true
    setCreating(true)
    args.setError('')
    try {
      if (args.sshRequiresConnection) {
        args.setError(`Connect ${selectedRepo.displayName} before creating a workspace.`)
        return
      }
      let latestRuntimeSettings = args.runtimeSettings
      try {
        const settings = await operations.readRuntimeSettings()
        latestRuntimeSettings = settings
        args.setRuntimeSettings(settings)
      } catch {}
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
          args.retiredWorktreeNames ?? undefined
        )
      let setupDecision: SetupDecision = 'inherit'
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
      const agentChoice = normalizeWorkspaceAgent(args.selectedAgent.id) ?? 'blank'
      const trimmedNote = args.note.trim() || undefined
      const result = args.composer.createSelection
        ? await operations.createWorkspaceFromSource({
            selection: args.composer.createSelection,
            targetRepoId: selectedRepo.id,
            setupDecision,
            agentChoice,
            workspaceName: trimmedName || undefined,
            note: trimmedNote,
            nameIsAutoManaged: args.composer.isNameAutoManaged,
            worktreeCreateIdempotency: args.getWorktreeCreateCutoverSupport()
          })
        : await operations.createBlankWorkspace({
            repoId: selectedRepo.id,
            baseName,
            agentChoice,
            nameWasGenerated: !trimmedName,
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
    const { operations } = args
    if (
      !operations ||
      !setupTrustPrompt ||
      setupTrustActionInFlightRef.current ||
      createInFlightRef.current
    ) {
      return
    }
    setupTrustActionInFlightRef.current = true
    setCreating(true)
    try {
      const nextTrust = await operations.persistSetupTrust({
        trust: args.trustedOrcaHooks,
        repoId: setupTrustPrompt.repoId,
        contentHash: setupTrustPrompt.contentHash,
        alwaysTrust
      })
      args.setTrustedOrcaHooks(nextTrust)
      const approvedHash = setupTrustPrompt.contentHash
      setSetupTrustPrompt(null)
      args.transitionDrawer('form')
      await handleCreate({ setupOverride: 'run', approvedSetupContentHash: approvedHash })
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
    void handleCreate({ setupOverride: 'skip' })
  }
  return {
    creating,
    setupTrustPrompt,
    handleCreate,
    approveSetupTrust,
    closeSetupTrust,
    skipSetupTrust
  }
}
