import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { normalizeSetupHookTrust } from '../tasks/setup-hook-trust'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type {
  MobileWorkspaceRepo,
  RepoHooksResponse,
  SetupHookDetails
} from './new-worktree-modal-types'

export function useNewWorkspaceSetupScript(args: {
  client: RpcClient | null
  selectedRepo: MobileWorkspaceRepo | null
}): {
  setupCommand: string | null
  setupSource: string | null
  setupTrust: SetupHookDetails['trust']
  setupRunPolicy: SetupHookDetails['runPolicy']
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  setSetupDecisionChoice: (decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'>) => void
  runSetup: boolean
  setRunSetup: (run: boolean) => void
  showAdvanced: boolean
  setShowAdvanced: (show: boolean) => void
} {
  const { client, selectedRepo } = args
  const [details, setDetails] = useState<SetupHookDetails | null>(null)
  const [setupDecisionChoice, setSetupDecisionChoice] = useState<Exclude<
    WorkspaceCreateSetupDecision,
    'inherit'
  > | null>(null)
  const [runSetup, setRunSetup] = useState(true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const activeDetails = selectedRepo && details?.repoId === selectedRepo.id ? details : null

  useEffect(() => {
    if (!client || !selectedRepo) {
      return
    }
    let stale = false
    void client
      .sendRequest('repo.hooks', { repo: `id:${selectedRepo.id}` })
      .then((response) => {
        if (stale || !response.ok) {
          return
        }
        const result = (response as RpcSuccess).result as RepoHooksResponse
        const command = result.hooks?.scripts?.setup?.trim() || null
        const runPolicy = result.setupRunPolicy ?? 'run-by-default'
        setDetails({
          repoId: selectedRepo.id,
          command,
          source: result.source,
          trust: normalizeSetupHookTrust(result.setupTrust),
          runPolicy
        })
        setSetupDecisionChoice(null)
        setRunSetup(runPolicy !== 'skip-by-default')
        if (command && runPolicy === 'ask') {
          setShowAdvanced(true)
        }
      })
      .catch(() => {
        if (!stale) {
          setDetails({
            repoId: selectedRepo.id,
            command: null,
            source: null,
            trust: null,
            runPolicy: 'run-by-default'
          })
          setSetupDecisionChoice(null)
        }
      })
    return () => {
      stale = true
    }
  }, [client, selectedRepo])

  return {
    setupCommand: activeDetails?.command ?? null,
    setupSource: activeDetails?.source ?? null,
    setupTrust: activeDetails?.trust ?? null,
    setupRunPolicy: activeDetails?.runPolicy ?? 'run-by-default',
    setupDecisionChoice,
    setSetupDecisionChoice,
    runSetup,
    setRunSetup,
    showAdvanced,
    setShowAdvanced
  }
}
