import { join } from 'node:path'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  type AgentHookInstallManagedHooksParams
} from '../shared/agent-hook-relay'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { AgentHookInstallStatus, AgentHookTarget } from '../shared/agent-hook-types'
import { isManagedAgentHookTarget } from '../shared/managed-agent-hook-targets'

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
  /** Optional on the wire: clients older than #8711 ignore it, and a client
   *  talking to a relay that predates it must report the host as `unknown`
   *  rather than assuming the per-agent results were all green. */
  statuses?: AgentHookInstallStatus[]
}

export type ManagedHookRuntime = {
  installManagedHooks: (options?: {
    signal?: AbortSignal
    hostKeyFingerprint?: string
    agents?: readonly AgentHookTarget[]
  }) => Promise<ManagedHookInstallSummary>
}

const SHA256_HOST_KEY_PATTERN = /^SHA256:[A-Za-z\d+/]{43}$/

function readHostKeyFingerprint(params: unknown): string | undefined {
  const fingerprint = (params as Partial<AgentHookInstallManagedHooksParams> | null)
    ?.hostKeyFingerprint
  return typeof fingerprint === 'string' && SHA256_HOST_KEY_PATTERN.test(fingerprint)
    ? fingerprint
    : undefined
}

function readAgents(params: unknown): AgentHookTarget[] {
  const raw = (params as Partial<AgentHookInstallManagedHooksParams> | null)?.agents
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw) || !raw.every(isManagedAgentHookTarget)) {
    throw new Error('invalid_managed_hook_agents')
  }
  return [...new Set(raw)]
}

let managedHookRuntime: ManagedHookRuntime | null = null

function loadManagedHookRuntime(): ManagedHookRuntime {
  if (!managedHookRuntime) {
    // Why: keep the sizeable installer implementation out of relay startup and
    // its narrow TS project while still executing it in-process on the remote.
    managedHookRuntime = require(join(__dirname, 'managed-hook-runtime.js')) as ManagedHookRuntime
  }
  return managedHookRuntime
}

export function registerManagedHookInstaller(
  dispatcher: Pick<RelayDispatcher, 'onRequest'>,
  loadRuntime: () => ManagedHookRuntime = loadManagedHookRuntime
): void {
  dispatcher.onRequest(
    AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
    async (params, context: RequestContext): Promise<ManagedHookInstallSummary> => {
      context.signal?.throwIfAborted()
      const hostKeyFingerprint = readHostKeyFingerprint(params)
      const agents = readAgents(params)
      return await loadRuntime().installManagedHooks({
        signal: context.signal,
        ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
        agents
      })
    }
  )
}
