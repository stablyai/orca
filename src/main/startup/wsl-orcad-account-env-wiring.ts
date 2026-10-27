import { BrowserWindow } from 'electron'
import { withClaudeProfileTerminalEnv } from '../claude-accounts/claude-profile-installed-router'
import { getSelectedClaudeAccountIdForTarget } from '../claude-accounts/runtime-selection'
import { getSelectedCodexAccountIdForTarget } from '../codex-accounts/runtime-selection'
import type { Store } from '../persistence'
import { installWslOrcadAccountEnvDependencies } from '../wsl/wsl-orcad-account-env'
import {
  WSL_ORCAD_ACCOUNT_NOT_APPLIED_CHANNEL,
  type WslOrcadAccountNotAppliedEvent
} from '../../shared/wsl-orcad-account-notice'
import { mainProcessState as state } from './main-process-state'

/** Calls `send` once per distro (case-insensitive) for the life of this process. */
export function oncePerDistro(send: (distro: string) => void): (distro: string) => void {
  const sent = new Set<string>()
  return (distro) => {
    const key = distro.trim().toLowerCase()
    if (sent.has(key)) {
      return
    }
    sent.add(key)
    send(distro)
  }
}

function broadcastAccountNotApplied(distro: string): void {
  const event: WslOrcadAccountNotAppliedEvent = { distro }
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(WSL_ORCAD_ACCOUNT_NOT_APPLIED_CHANNEL, event)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function installWslOrcadAccountShim(store: Pick<Store, 'getSettings'>): void {
  installWslOrcadAccountEnvDependencies({
    prepareClaudeLaunch: (target) => {
      const auth = state.claudeRuntimeAuth
      if (!auth) {
        throw new Error('Claude account service is not initialized')
      }
      return auth.prepareForClaudeLaunch(target)
    },
    claudeTerminalEnv: (target) => withClaudeProfileTerminalEnv({}, target),
    prepareCodexHome: async (target) => {
      const runtimeHome = state.codexRuntimeHome
      if (!runtimeHome || !getSelectedCodexAccountIdForTarget(store.getSettings(), target)) {
        return null
      }
      // Do not install desktop relay hooks: WSL agent status belongs to that host's orcad.
      return runtimeHome.prepareForCodexLaunchAsync(target)
    },
    managedAccountSelected: (target) => {
      const settings = store.getSettings()
      return Boolean(
        getSelectedClaudeAccountIdForTarget(settings, target) ||
        getSelectedCodexAccountIdForTarget(settings, target)
      )
    },
    accountNotApplied: oncePerDistro(broadcastAccountNotApplied)
  })
}
