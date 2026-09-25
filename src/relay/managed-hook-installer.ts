import { join } from 'node:path'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  type AgentHookInstallManagedHooksParams
} from '../shared/agent-hook-relay'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { AgentHookTarget } from '../shared/agent-hook-types'
import { isManagedAgentHookTarget } from '../shared/managed-agent-hook-targets'
import { parseCliVersion } from '../shared/app-version'

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

export type ManagedHookRuntime = {
  installManagedHooks: (options?: {
    signal?: AbortSignal
    hostKeyFingerprint?: string
    agents?: readonly AgentHookTarget[]
    claudeVersion?: string
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

function readClaudeVersion(params: unknown): string | undefined {
  const raw =
    params !== null && typeof params === 'object' && 'claudeVersion' in params
      ? params.claudeVersion
      : null
  return parseCliVersion(typeof raw === 'string' ? raw : null) ?? undefined
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
      const claudeVersion = readClaudeVersion(params)
      return await loadRuntime().installManagedHooks({
        signal: context.signal,
        ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}),
        agents,
        ...(claudeVersion ? { claudeVersion } : {})
      })
    }
  )
}
