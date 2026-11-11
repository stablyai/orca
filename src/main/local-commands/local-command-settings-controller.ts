import type {
  LocalCommandsState,
  LocalCommandWorkspaceRow
} from '../../shared/local-commands/local-command-desktop-types'
import type { LocalCloudWorkspaceRef, LocalCommandBridge } from './local-command-bridge'
import type { LocalCommandSettingsStore } from './local-command-settings-store'

export type LocalCommandSettingsControllerDeps = {
  bridge: LocalCommandBridge
  settings: LocalCommandSettingsStore
  supported: boolean
  listWorkspaces: () => LocalCloudWorkspaceRef[]
  publishState: () => void
  now?: () => number
}

/** What Settings shows and changes. Turning on re-checks ownership and sharing with the registry. */
export function createLocalCommandSettingsController(deps: LocalCommandSettingsControllerDeps) {
  const now = deps.now ?? Date.now
  return {
    async setEnabled(
      sandboxId: string,
      enabled: boolean,
      allowShared: boolean
    ): Promise<{ ok: boolean; error?: string }> {
      if (!deps.supported) {
        return { ok: false, error: 'unsupported' }
      }
      if (!deps.listWorkspaces().some((w) => w.sandboxId === sandboxId)) {
        return { ok: false, error: 'not_found' }
      }
      if (enabled) {
        const policy = await deps.bridge.policyOf(sandboxId, true)
        if (!policy) {
          return { ok: false, error: 'unverified' }
        }
        if (!policy.isOwner) {
          return { ok: false, error: 'not_owner' }
        }
        if (policy.shared && !allowShared) {
          return { ok: false, error: 'shared_needs_confirmation' }
        }
        deps.settings.setEnabled(sandboxId, true, policy.shared && allowShared, now())
      } else {
        deps.settings.setEnabled(sandboxId, false, false, now())
        deps.bridge.dropPromptsFor(sandboxId)
      }
      deps.bridge.reconcile()
      deps.publishState()
      return { ok: true }
    },

    removeRule(id: string): boolean {
      const removed = deps.settings.removeRule(id)
      if (removed) {
        deps.publishState()
      }
      return removed
    },

    async state(): Promise<LocalCommandsState> {
      const workspaces: LocalCommandWorkspaceRow[] = []
      for (const workspace of deps.listWorkspaces()) {
        const setting = deps.settings.workspace(workspace.sandboxId)
        const policy = await deps.bridge.policyOf(workspace.sandboxId, false)
        workspaces.push({
          sandboxId: workspace.sandboxId,
          label: deps.bridge.labelOf(workspace.sandboxId),
          enabled: setting?.enabled === true,
          sharedAllowed: setting?.sharedAllowed === true,
          shared: policy ? policy.shared : null,
          isOwner: policy ? policy.isOwner : null,
          connected: deps.bridge.isConnected(workspace.sandboxId)
        })
      }
      return {
        available: deps.supported,
        workspaces,
        rules: deps.settings.rules(now()).map((rule) => ({
          ...rule,
          workspaceLabel: deps.bridge.labelOf(rule.sandboxId)
        }))
      }
    }
  }
}

export type LocalCommandSettingsController = ReturnType<typeof createLocalCommandSettingsController>
