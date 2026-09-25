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
import { extractJiraConnection, type MobileJiraConnection } from '../tasks/jira-mobile-connection'
import { jiraConnectionStatusProbe } from '../tasks/mobile-jira-operations'
import type { NewWorktreeRuntimeSettings } from './new-worktree-agent-selection'
import { newWorkspaceUiStateRead } from './new-workspace-operations'

/** One member off a probe payload the drawer only re-typed, keeping its optional-chaining read. */
function readProbeMember(payload: unknown, key: string): unknown {
  return payload == null ? undefined : Object(payload)[key]
}

/** A settled probe's accepted payload, or undefined when it never landed or was refused. */
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
  // Tracked apart from availableProviders: filterAvailableTaskProviders reports
  // Jira as always available so Tasks can offer setup, but the composer tab is
  // only useful once a site is connected — and pasted-URL lookup needs the site
  // list to match against.
  const [jiraConnection, setJiraConnection] = useState<MobileJiraConnection>({
    connected: false,
    sites: [],
    selection: null,
    credentialError: null
  })

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    void (async () => {
      const probes = Promise.allSettled([
        taskPreflightRead.request(client),
        taskLinearStatusRead.request(client),
        jiraConnectionStatusProbe.request(client)
      ])
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

      const [preflightRes, linearRes, jiraRes] = await probes
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
      setJiraConnection(
        extractJiraConnection(settledValue(jiraRes, jiraConnectionStatusProbe.interpret))
      )
      const visibleProviders = normalizeVisibleTaskProviders(settingsValue?.visibleTaskProviders)
      setAvailableProviders(
        filterAvailableTaskProviders(visibleProviders, {
          gitlabInstalled: glabInstalled,
          linearConnected
        }).filter((provider) => visibleProviders.includes(provider))
      )
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
