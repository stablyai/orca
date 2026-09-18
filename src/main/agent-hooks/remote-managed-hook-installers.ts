import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus, AgentHookTarget } from '../../shared/agent-hook-types'
import {
  MANAGED_AGENT_INTEGRATIONS,
  type ManagedAgentRemoteInstallOptions
} from './managed-agent-hook-registry'

export type RemoteManagedHookInstallOptions = ManagedAgentRemoteInstallOptions & {
  /** Stops before starting the next installer when the owning relay request
   *  is cancelled. Individual filesystem mutations remain atomic. */
  signal?: AbortSignal
  /** Positively detected and enabled agents allowed to mutate config.
   *  Required for any install: omit/empty fails closed (no config mutation). */
  agents?: readonly AgentHookTarget[]
}

type RemoteManagedHookInstaller = readonly [
  AgentHookInstallStatus['agent'],
  (
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: RemoteManagedHookInstallOptions
  ) => Promise<AgentHookInstallStatus>
]

const REMOTE_MANAGED_HOOK_INSTALLERS: readonly RemoteManagedHookInstaller[] =
  MANAGED_AGENT_INTEGRATIONS.flatMap(({ agent, installRemote }) =>
    installRemote ? ([[agent, installRemote]] as const) : []
  )

/** Agents wired into the remote (SSH) hook installer. Exported so an invariant
 *  test can assert every locally-managed agent that implements `installRemote`
 *  is registered here — the omission that hid Droid/Copilot status over SSH. */
export const REMOTE_MANAGED_HOOK_INSTALLER_AGENTS: readonly AgentHookInstallStatus['agent'][] =
  REMOTE_MANAGED_HOOK_INSTALLERS.map(([agent]) => agent)

export async function installRemoteManagedAgentHooks(
  sftp: SFTPWrapper,
  remoteHome: string,
  options?: RemoteManagedHookInstallOptions
): Promise<AgentHookInstallStatus[]> {
  // Why: omit/empty allowlist must never mean "install every agent" — that
  // recreates config homes for CLIs the user never installed (issue #11641).
  const allowedAgents = new Set(options?.agents ?? [])
  if (allowedAgents.size === 0) {
    return []
  }
  const results: AgentHookInstallStatus[] = []
  for (const [agent, install] of REMOTE_MANAGED_HOOK_INSTALLERS) {
    if (!allowedAgents.has(agent)) {
      continue
    }
    // Why: relay requests can disappear during reconnect; do not start more
    // user-config mutations after their client has gone away.
    options?.signal?.throwIfAborted()
    try {
      const result = await install(sftp, remoteHome, options)
      results.push(result)
      if (result.state === 'error') {
        console.warn(
          `[agent-hooks] Remote ${agent} managed hook install failed for ${result.configPath}: ${
            result.detail ?? 'unknown error'
          }`
        )
      }
    } catch (error) {
      // Why: remote hook installation must not block SSH workspace startup.
      // A broken agent config or transient SFTP failure should degrade status
      // reporting only, while terminals/filesystem/git still come online.
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[agent-hooks] Remote ${agent} managed hook install threw: ${detail}`)
      results.push({
        agent,
        state: 'error',
        configPath: remoteHome,
        managedHooksPresent: false,
        detail
      })
    }
  }
  return results
}
