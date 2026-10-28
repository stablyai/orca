import { optionalSettingsRead } from '../transport/settings-read-operations'
import { useEffect, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { RpcAcceptedResult } from '../transport/rpc-accepted-result'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { taskLinearStatusRead, taskPreflightRead } from '../tasks/mobile-task-runtime-operations'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../../../src/shared/task-providers'
import {
  readJiraConnectionProbeReply,
  type MobileJiraConnection
} from '../tasks/jira-mobile-connection'
import { jiraConnectionStatusProbe } from '../tasks/mobile-jira-operations'
import { useMobileJiraConnectionState } from '../tasks/use-mobile-jira-connection-state'
import type { NewWorktreeRuntimeSettings } from './new-worktree-agent-selection'
import { newWorkspaceUiStateRead } from './new-workspace-operations'

function readProbeMember(payload: unknown, key: string): unknown {
  return payload == null ? undefined : Object(payload)[key]
}

function settledValue(
  entry: PromiseSettledResult<RpcResponse>,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<unknown>
): unknown {
  if (entry.status !== 'fulfilled') {
    return undefined
  }
  const verdict = interpret(entry.value)
  return verdict.accepted ? verdict.value : undefined
}

export function useNewWorkspaceRuntimeContext(
  client: RpcClient | null,
  visible: boolean,
  hostId?: string
): {
  runtimeSettings: NewWorktreeRuntimeSettings | null
  setRuntimeSettings: (settings: NewWorktreeRuntimeSettings) => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  setTrustedOrcaHooks: (trust: PersistedTrustedOrcaHooks) => void
  availableProviders: TaskProvider[]
  jiraConnection: MobileJiraConnection
} {
  const [runtimeSettings, setRuntimeSettings] = useState<NewWorktreeRuntimeSettings | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [availableProviders, setAvailableProviders] = useState<TaskProvider[]>([])
  // Tasks can offer Jira setup; the composer requires a connected site.
  const [jiraConnection, setJiraConnection] = useMobileJiraConnectionState(
    client,
    visible ? `visible:${hostId ?? ''}` : 'hidden'
  )

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    void (async () => {
      const probes = Promise.allSettled([
        taskPreflightRead.request(client),
        taskLinearStatusRead.request(client)
      ])
      const jiraProbe = Promise.allSettled([jiraConnectionStatusProbe.request(client)])
      const [settingsRes, uiRes] = await Promise.allSettled([
        optionalSettingsRead.request(client),
        newWorkspaceUiStateRead.request(client)
      ])
      if (stale) {
        return
      }

      const settingsResult =
        settingsRes.status === 'fulfilled'
          ? optionalSettingsRead.interpret(settingsRes.value)
          : null
      const settingsValue = settingsResult?.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          (settingsResult.value as NewWorktreeRuntimeSettings & { visibleTaskProviders?: unknown })
        : null
      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }
      if (uiRes.status === 'fulfilled') {
        const ui = newWorkspaceUiStateRead.interpret(uiRes.value)
        if (ui.accepted) {
          setTrustedOrcaHooks(ui.value?.trustedOrcaHooks ?? {})
        }
      }

      const [preflightRes, linearRes] = await probes
      if (stale) {
        return
      }
      const glabInstalled =
        readProbeMember(
          readProbeMember(settledValue(preflightRes, taskPreflightRead.interpret), 'glab'),
          'installed'
        ) === true
      const linearConnected =
        readProbeMember(settledValue(linearRes, taskLinearStatusRead.interpret), 'connected') ===
        true
      const visibleProviders = normalizeVisibleTaskProviders(settingsValue?.visibleTaskProviders)
      setAvailableProviders(
        filterAvailableTaskProviders(visibleProviders, {
          gitlabInstalled: glabInstalled,
          linearConnected
        }).filter((provider) => visibleProviders.includes(provider))
      )
      const [jiraRes] = await jiraProbe
      if (!stale) {
        setJiraConnection(
          readJiraConnectionProbeReply(jiraRes.status === 'fulfilled' ? jiraRes.value : null)
        )
      }
    })()
    return () => {
      stale = true
    }
  }, [visible, client, hostId])

  return {
    runtimeSettings,
    setRuntimeSettings,
    trustedOrcaHooks,
    setTrustedOrcaHooks,
    availableProviders,
    jiraConnection
  }
}
