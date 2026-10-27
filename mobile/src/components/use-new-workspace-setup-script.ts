import { useCallback, useEffect, useState } from 'react'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { normalizeSetupHookTrust, readRepoHooksSetupCommand } from '../tasks/setup-hook-trust'
import { newWorkspaceSetupHooksRead } from './new-workspace-operations'
import type { WorkspaceCreateSetupDecision } from '../tasks/workspace-create-params'
import type { MobileWorkspaceRepo, SetupHookDetails } from './new-worktree-modal-types'

type SetupScriptValues = {
  details: SetupHookDetails | null
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  showAdvanced: boolean
}

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
  const repoId = selectedRepo?.id ?? null
  const executionHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null
  const emptyValues: SetupScriptValues = {
    details: null,
    setupDecisionChoice: null,
    runSetup: true,
    showAdvanced: false
  }
  const [state, setState] = useState({ client, repoId, executionHostId, ...emptyValues })
  const matchesOwner =
    state.client === client && state.repoId === repoId && state.executionHostId === executionHostId
  if (!matchesOwner) {
    setState({ client, repoId, executionHostId, ...emptyValues })
  }
  const {
    details: activeDetails,
    setupDecisionChoice,
    runSetup,
    showAdvanced
  } = matchesOwner ? state : emptyValues
  const updateChoices = useCallback(
    (values: Partial<SetupScriptValues>) => {
      setState((current) =>
        current.client === client &&
        current.repoId === repoId &&
        current.executionHostId === executionHostId
          ? { ...current, ...values }
          : current
      )
    },
    [client, repoId, executionHostId]
  )

  useEffect(() => {
    if (!client || !repoId) {
      return
    }
    let stale = false
    void newWorkspaceSetupHooksRead
      .request(client, { repo: `id:${repoId}` })
      .then((reply) => {
        const hooks = newWorkspaceSetupHooksRead.interpret(reply)
        if (stale || !hooks.accepted) {
          return
        }
        const result = hooks.value
        const command = readRepoHooksSetupCommand(result)
        const runPolicy = result.setupRunPolicy ?? 'run-by-default'
        updateChoices({
          details: {
            repoId,
            command,
            source: result.source,
            trust: normalizeSetupHookTrust(result.setupTrust),
            runPolicy
          },
          setupDecisionChoice: null,
          runSetup: runPolicy !== 'skip-by-default',
          ...(command && runPolicy === 'ask' ? { showAdvanced: true } : {})
        })
      })
      .catch(() => {
        if (!stale) {
          updateChoices({ details: null, setupDecisionChoice: null })
        }
      })
    return () => {
      stale = true
    }
  }, [client, repoId, updateChoices])

  return {
    setupCommand: activeDetails?.command ?? null,
    setupSource: activeDetails?.source ?? null,
    setupTrust: activeDetails?.trust ?? null,
    setupRunPolicy: activeDetails?.runPolicy ?? 'run-by-default',
    setupDecisionChoice,
    setSetupDecisionChoice: (setupDecisionChoice) => updateChoices({ setupDecisionChoice }),
    runSetup,
    setRunSetup: (runSetup) => updateChoices({ runSetup }),
    showAdvanced,
    setShowAdvanced: (showAdvanced) => updateChoices({ showAdvanced })
  }
}
