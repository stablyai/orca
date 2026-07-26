import { join } from 'node:path'
import {
  AGENT_HOOK_INSTALL_MANAGED_HOOKS_METHOD,
  type AgentHookInstallManagedHooksParams
} from '../shared/agent-hook-relay'
import type { RelayDispatcher, RequestContext } from './dispatcher'

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

export type ManagedHookRuntime = {
  installManagedHooks: (options?: {
    signal?: AbortSignal
    hostKeyFingerprint?: string
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
      return await loadRuntime().installManagedHooks({
        signal: context.signal,
        ...(hostKeyFingerprint ? { hostKeyFingerprint } : {})
      })
    }
  )
}
