import { useCallback, useEffect, useState } from 'react'
import { getRepoExecutionHostId } from '../../../../../src/shared/execution-host/execution-host'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { readRepoHooksSetupCommand } from '../setup-hook-trust'
import { newWorkspaceSetupHooksRead } from './new-workspace-operations'
import { getRepoSetupAgentStartupPolicy } from '../../../../../src/shared/workspace-setup/repo-hook-settings-defaults'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../../src/shared/worktree/create-types'
import type { MobileWorkspaceRepo, SetupHookDetails } from '../forms/new-worktree-modal-types'

type SetupScriptValues = {
  details: SetupHookDetails | null
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  runSetup: boolean
  showAdvanced: boolean
  waitForSetupChoice: boolean | null
}

export function useNewWorkspaceSetupScript(args: {
  client: RpcClient | null
  selectedRepo: MobileWorkspaceRepo | null
}): {
  setupCommand: string | null
  setupSource: string | null
  setupRunPolicy: SetupHookDetails['runPolicy']
  setupDecisionChoice: Exclude<WorkspaceCreateSetupDecision, 'inherit'> | null
  setSetupDecisionChoice: (decision: Exclude<WorkspaceCreateSetupDecision, 'inherit'>) => void
  runSetup: boolean
  setRunSetup: (run: boolean) => void
  showAdvanced: boolean
  setShowAdvanced: (show: boolean) => void
  /** Null when the host reports no setup script to wait for (or predates the report). */
  waitForSetup: boolean | null
  /** The user's own flip of the switch, saved before create; null when untouched or hidden. */
  waitForSetupChoice: boolean | null
  setWaitForSetup: (wait: boolean) => void
} {
  const { client, selectedRepo } = args
  const repoId = selectedRepo?.id ?? null
  const executionHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null
  const emptyValues: SetupScriptValues = {
    details: null,
    setupDecisionChoice: null,
    runSetup: true,
    showAdvanced: false,
    waitForSetupChoice: null
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
    showAdvanced,
    waitForSetupChoice
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
            runPolicy,
            // As desktop: default tabs alone are no setup to wait for; older hosts send no setupConfig.
            agentCanWaitForSetup: !!result.setupConfig && result.setupConfig.kind !== 'default-tabs'
          },
          setupDecisionChoice: null,
          waitForSetupChoice: null,
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
    setupRunPolicy: activeDetails?.runPolicy ?? 'run-by-default',
    setupDecisionChoice,
    setSetupDecisionChoice: (setupDecisionChoice) => updateChoices({ setupDecisionChoice }),
    runSetup,
    setRunSetup: (runSetup) => updateChoices({ runSetup }),
    showAdvanced,
    setShowAdvanced: (showAdvanced) => updateChoices({ showAdvanced }),
    waitForSetup: activeDetails?.agentCanWaitForSetup
      ? (waitForSetupChoice ??
        getRepoSetupAgentStartupPolicy(selectedRepo ?? undefined) === 'wait-for-setup')
      : null,
    waitForSetupChoice: activeDetails?.agentCanWaitForSetup ? waitForSetupChoice : null,
    setWaitForSetup: (waitForSetupChoice) => updateChoices({ waitForSetupChoice })
  }
}
