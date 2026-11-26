import { useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import type { SetupDecision } from '../../../../../src/shared/worktree/create-types'
import type { OrcaHookTrustPrompt } from '../../../components/hook-trust/OrcaHookTrustDrawer'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { MobileComposerCreateSelection } from '../../source-selection/mobile-composer-source-types'
import type { NewWorktreeDrawerView } from '../modal/use-new-worktree-drawer-navigation'
import { createdSetupRunFailed, runReviewedCreatedSetup } from '../created-worktree-setup-review'
import {
  approvedCreateSetup,
  persistSetupHookTrustApproval,
  type CreateSetupApproval
} from '../setup-hook-trust'

export type CreateOptions = {
  setupOverride?: Exclude<SetupDecision, 'inherit'>
  setupApproval?: CreateSetupApproval
  /** The source whose setup the user saw, so the create doesn't resolve it again. */
  selection?: MobileComposerCreateSelection
}

export type CreatedWorkspace = { worktreeId: string; name: string; warning?: string }

export type SheetSetupTrustPrompt = OrcaHookTrustPrompt & {
  selection?: MobileComposerCreateSelection
  /** The workspace exists; only its skipped setup is under review. */
  created?: CreatedWorkspace
}

export function useNewWorkspaceSetupTrust(args: {
  client: RpcClient | null
  repos: readonly { id: string }[]
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  setTrustedOrcaHooks: (trust: PersistedTrustedOrcaHooks) => void
  transitionDrawer: (view: Exclude<NewWorktreeDrawerView, 'transition'>) => void
  setError: Dispatch<SetStateAction<string>>
  createInFlight: () => boolean
  setCreating: (creating: boolean) => void
  create: (options: CreateOptions) => Promise<void>
  finishCreated: (created: CreatedWorkspace, notice?: string) => void
}) {
  const inFlightRef = useRef(false)
  const [prompt, setPrompt] = useState<SheetSetupTrustPrompt | null>(null)

  function ask(next: SheetSetupTrustPrompt): void {
    setPrompt(next)
    args.transitionDrawer('trust')
  }

  async function approve(alwaysTrust: boolean): Promise<void> {
    if (!args.client || !prompt || inFlightRef.current || args.createInFlight()) {
      return
    }
    inFlightRef.current = true
    args.setCreating(true)
    try {
      const nextTrust = await persistSetupHookTrustApproval({
        client: args.client,
        trust: args.trustedOrcaHooks,
        repos: args.repos,
        repoId: prompt.repoId,
        contentHash: prompt.contentHash,
        alwaysTrust
      })
      args.setTrustedOrcaHooks(nextTrust)
      setPrompt(null)
      if (prompt.created) {
        const notice = await runReviewedCreatedSetup(
          args.client,
          prompt.created.worktreeId,
          prompt.contentHash
        )
        args.finishCreated(prompt.created, notice)
        return
      }
      args.transitionDrawer('form')
      await args.create({
        setupOverride: 'run',
        setupApproval: approvedCreateSetup(args.repos, prompt, alwaysTrust),
        selection: prompt.selection
      })
    } catch (error) {
      if (prompt.created) {
        // The workspace exists; open it saying its setup didn't start.
        setPrompt(null)
        args.finishCreated(prompt.created, createdSetupRunFailed())
        return
      }
      args.setError(error instanceof Error ? error.message : 'Failed to trust setup script.')
    } finally {
      inFlightRef.current = false
      if (!args.createInFlight()) {
        args.setCreating(false)
      }
    }
  }

  // Declining a created workspace's setup leaves it as is and opens it.
  function close(): SheetSetupTrustPrompt | null {
    if (!prompt || inFlightRef.current || args.createInFlight()) {
      return null
    }
    setPrompt(null)
    if (prompt.created) {
      args.finishCreated(prompt.created)
    } else {
      args.transitionDrawer('form')
    }
    return prompt
  }

  function skip(): void {
    const closed = close()
    if (closed && !closed.created) {
      void args.create({ setupOverride: 'skip', selection: closed.selection })
    }
  }

  return { prompt, ask, approve, close: () => void close(), skip }
}
