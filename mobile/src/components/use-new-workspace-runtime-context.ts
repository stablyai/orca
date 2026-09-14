import { settingsRead } from '../transport/settings-read-operations'
import { useEffect, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import type { NewWorktreeRuntimeSettings } from './new-worktree-agent-selection'

function settledSuccess(entry: PromiseSettledResult<RpcResponse>): RpcSuccess | null {
  return entry.status === 'fulfilled' && entry.value.ok ? (entry.value as RpcSuccess) : null
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
        client.sendRequest('preflight.check'),
        client.sendRequest('linear.status')
      ])
      const [settingsRes, uiRes] = await Promise.allSettled([
        settingsRead.request(client),
        client.sendRequest('ui.get')
      ])
      if (stale) {
        return
      }

      const settingsResult =
        settingsRes.status === 'fulfilled' ? settingsRead.interpret(settingsRes.value) : null
      const settingsValue = settingsResult?.accepted
        ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
          (settingsResult.value as NewWorktreeRuntimeSettings & { visibleTaskProviders?: unknown })
        : null
      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }
      const uiResult = settledSuccess(uiRes)
      if (uiResult) {
        const ui = (uiResult.result as { ui?: { trustedOrcaHooks?: PersistedTrustedOrcaHooks } }).ui
        setTrustedOrcaHooks(ui?.trustedOrcaHooks ?? {})
      }

      const [preflightRes, linearRes] = await probes
      if (stale) {
        return
      }
      const glabInstalled =
        (settledSuccess(preflightRes)?.result as { glab?: { installed?: boolean } } | undefined)
          ?.glab?.installed === true
      const linearConnected =
        (settledSuccess(linearRes)?.result as { connected?: boolean } | undefined)?.connected ===
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
