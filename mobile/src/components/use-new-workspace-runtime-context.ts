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
} from '../tasks/mobile-task-providers'
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
} {
  const [runtimeSettings, setRuntimeSettings] = useState<NewWorktreeRuntimeSettings | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [availableProviders, setAvailableProviders] = useState<TaskProvider[]>([])

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
    availableProviders
  }
}
