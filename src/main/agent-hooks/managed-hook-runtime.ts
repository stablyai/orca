import { homedir } from 'node:os'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'
import {
  resolveExecutionHostGrokHome,
  resolveRedirectedExecutionHostCodexHome
} from './execution-host-agent-homes'

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

/** Kept as the relay-facing name for the Grok probe; the resolution itself now
 *  lives with every other execution-host home. */
export const resolveRelayGrokHome = resolveExecutionHostGrokHome

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
  agents?: readonly AgentHookTarget[]
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  // Why: empty/omitted allowlist fails closed before any home/host probes.
  const agents = options?.agents ?? []
  if (agents.length === 0) {
    return { installers: 0, errors: 0 }
  }
  const home = homedir()
  const grokHomeDir = await resolveExecutionHostGrokHome(home, options?.signal)
  options?.signal?.throwIfAborted()
  // Why: gated on Codex being present so a host without it never pays for an
  // app-server handshake, and only a home that is actually redirected is passed
  // on — handing the installer the default `~/.codex` would change nothing about
  // where hooks land while flipping every ordinary SSH host onto the
  // redirected-runtime contract.
  const codexHomeDir = agents.includes('codex')
    ? await resolveRedirectedExecutionHostCodexHome(home, options?.signal)
    : undefined
  options?.signal?.throwIfAborted()
  const hostIdentity = scopeManagedHookHostIdentity(
    await readManagedHookHostIdentity(),
    options?.hostKeyFingerprint
  )
  return await withManagedHookInstallLock(
    home,
    options?.signal,
    async () => {
      const results = await installRemoteManagedAgentHooks(
        createManagedHookLocalFilesystem(),
        home,
        {
          ...(codexHomeDir ? { codexHomeDir, useRuntimeInstallerHookContract: false } : {}),
          grokHomeDir,
          signal: options?.signal,
          agents
        }
      )
      return {
        installers: results.length,
        errors: results.filter((result) => result.state === 'error').length
      }
    },
    hostIdentity
  )
}
