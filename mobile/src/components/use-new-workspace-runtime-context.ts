import { useEffect, useState } from 'react'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  type TaskProvider
} from '../tasks/mobile-task-providers'
import type {
  HostWorkspaceCreationOperations,
  NewWorkspaceRuntimeSettings
} from '../worktree/host-workspace-creation-operations'

export function useNewWorkspaceRuntimeContext(
  operations: HostWorkspaceCreationOperations | null,
  visible: boolean
): {
  runtimeSettings: NewWorkspaceRuntimeSettings | null
  setRuntimeSettings: (settings: NewWorkspaceRuntimeSettings) => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  setTrustedOrcaHooks: (trust: PersistedTrustedOrcaHooks) => void
  availableProviders: TaskProvider[]
} {
  const [runtimeSettings, setRuntimeSettings] = useState<NewWorkspaceRuntimeSettings | null>(null)
  const [trustedOrcaHooks, setTrustedOrcaHooks] = useState<PersistedTrustedOrcaHooks>({})
  const [availableProviders, setAvailableProviders] = useState<TaskProvider[]>([])

  useEffect(() => {
    if (!visible || !operations) {
      return
    }
    let stale = false
    void (async () => {
      const probes = Promise.allSettled([
        operations.isGitLabCliInstalled(),
        operations.isLinearConnected()
      ])
      const [settingsRes, uiRes] = await Promise.allSettled([
        operations.readRuntimeSettings(),
        operations.readTrustedHooks()
      ])
      if (stale) {
        return
      }

      const settingsValue = settingsRes.status === 'fulfilled' ? settingsRes.value : null
      if (settingsValue) {
        setRuntimeSettings(settingsValue)
      }
      if (uiRes.status === 'fulfilled') {
        setTrustedOrcaHooks(uiRes.value)
      }

      const [preflightRes, linearRes] = await probes
      if (stale) {
        return
      }
      const glabInstalled = preflightRes.status === 'fulfilled' && preflightRes.value
      const linearConnected = linearRes.status === 'fulfilled' && linearRes.value
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
  }, [visible, operations])

  return {
    runtimeSettings,
    setRuntimeSettings,
    trustedOrcaHooks,
    setTrustedOrcaHooks,
    availableProviders
  }
}
