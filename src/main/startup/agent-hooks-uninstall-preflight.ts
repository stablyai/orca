import { app } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { setAppEnvironment } from '../../shared/app-environment'
import { ElectronAppEnvironment } from '../host/electron-app-environment'
import { ensureWindowsAppDataPath } from './windows-app-data-path'

/** The NSIS uninstaller's flag (config/nsis/orca-installer-hooks.nsh); keep the two in sync. */
export const AGENT_HOOKS_UNINSTALL_FLAG = '--orca-uninstall-remove-agent-hooks'

// Uninstall must finish even if an agent's config never answers.
const UNINSTALL_HOOK_REMOVAL_TIMEOUT_MS = 30_000

/** Exit code 0 only when every agent's managed hooks were removed or never there. */
export async function removeAgentHooksForUninstall(
  removeHooks: () => Promise<readonly AgentHookInstallStatus[]>
): Promise<number> {
  try {
    const statuses = await removeHooks()
    const failed = statuses.filter((status) => status.state === 'error')
    for (const status of failed) {
      console.warn(
        `[agent-hooks] uninstall left ${status.agent} hooks: ${status.detail ?? 'error'}`
      )
    }
    return failed.length === 0 ? 0 : 1
  } catch (error) {
    console.warn('[agent-hooks] uninstall could not remove managed agent hooks:', error)
    return 1
  }
}

/**
 * Uninstall only: Windows hook entries call the ~/.orca scripts by bare path, so once that folder
 * is removed every agent would fail a hook per event; the last install takes them out. File edits
 * only; no window or shell.
 */
export function runAgentHooksUninstallPreflight(argv: readonly string[] = process.argv): boolean {
  if (!argv.includes(AGENT_HOOKS_UNINSTALL_FLAG)) {
    return false
  }
  // Armed first: nothing below may leave the uninstaller waiting on an error box.
  const timeout = setTimeout(() => app.exit(1), UNINSTALL_HOOK_REMOVAL_TIMEOUT_MS)
  try {
    process.env.ORCA_BACKGROUND_LAUNCH = '1'
    // The same userData the app's managed runtime homes live under.
    ensureWindowsAppDataPath(app)
    // Removers read userData through this port (Claude's profile homes); the app's own preflight is skipped.
    setAppEnvironment(new ElectronAppEnvironment())
  } catch (error) {
    console.warn('[agent-hooks] uninstall could not start removing managed agent hooks:', error)
    clearTimeout(timeout)
    app.exit(1)
    return true
  }
  // Loaded only here, so ordinary startup never pays for every agent's hook module.
  void removeAgentHooksForUninstall(async () => {
    const { removeManagedAgentHooks } = await import('../agent-hooks/managed-agent-hook-controls')
    return removeManagedAgentHooks()
  }).then((code) => {
    clearTimeout(timeout)
    app.exit(code)
  })
  return true
}
