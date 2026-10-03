import type { PtySpawnOptions } from './types'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'
import { buildSshPtySpawnEnv } from './ssh-pty-spawn-env'
import { PTY_STARTUP_INGRESS_VERSION } from '../../shared/pty-startup-ingress'

export function buildSshPtySpawnRequest(args: {
  options: PtySpawnOptions
  remoteCliBridgeEnv?: RemoteCliBridgeEnv
  supportsCreateOperation: boolean
}): Record<string, unknown> {
  const { options } = args
  return {
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: buildSshPtySpawnEnv({
      env: options.env,
      envToDelete: options.envToDelete,
      remoteCliBridgeEnv: args.remoteCliBridgeEnv
    }),
    ...(options.envToDelete?.length ? { envToDelete: options.envToDelete } : {}),
    // Why: the relay needs launch identity for plugin env overlays and provider-side delivery.
    ...(options.command ? { command: options.command } : {}),
    ...(options.launchAgent ? { launchAgent: options.launchAgent } : {}),
    ...(options.worktreeId ? { worktreeId: options.worktreeId } : {}),
    ...(options.historyIsolationEnabled !== undefined
      ? { historyIsolationEnabled: options.historyIsolationEnabled }
      : {}),
    // Why: without this the relay's remote shell records command history to disk on the execution
    // host for a `--no-session` terminal — the desktop path's HISTFILE=/dev/null never crossed the
    // SSH boundary. Old relays ignore the extra param. See src/relay/pty-handler.ts spawnAfterAdmission.
    ...(options.incognito ? { incognito: true } : {}),
    ...(options.agentWorkspaceTrust ? { agentWorkspaceTrust: options.agentWorkspaceTrust } : {}),
    ...(options.shellOverride !== undefined ? { shellOverride: options.shellOverride } : {}),
    ...(options.terminalWindowsWslDistro !== undefined
      ? { terminalWindowsWslDistro: options.terminalWindowsWslDistro }
      : {}),
    ...(options.commandDelivery ? { commandDelivery: options.commandDelivery } : {}),
    ...(options.startupCommandDelivery
      ? { startupCommandDelivery: options.startupCommandDelivery }
      : {}),
    // Why: attach identity must survive even when hook variables are stripped from the shell env.
    ...(options.paneKey ? { paneKey: options.paneKey } : {}),
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ...(options.startupIngress
      ? {
          startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
          startupIngress: options.startupIngress
        }
      : {}),
    ...(options.agentSessionEnsure ? { agentSessionEnsure: options.agentSessionEnsure } : {}),
    ...(args.supportsCreateOperation
      ? { agentSessionCreateOperationId: options.agentSessionCreateOperationId }
      : {})
  }
}
