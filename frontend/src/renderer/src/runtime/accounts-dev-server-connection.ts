// TASK-023: accounts.* relays through infra-fleet-service's Relay RPC, which
// needs a connectionId — but a tenant can own 0..N live dev-server
// connections and nothing in the data model maps a runtime environment to
// one of them. Rather than have api-gateway guess (silently wrong for any
// tenant with more than one dev server), the user explicitly picks a dev
// server; this module resolves that choice to the connectionId
// accounts.selectClaude/selectCodex/removeClaude/removeCodex/subscribe need.
import { callRuntimeRpc, type RuntimeClientTarget } from './runtime-rpc-client'
import { runtimeClientState } from './runtime-client-state-client'

// Why localStorage, not GlobalSettings: this is a per-browser/per-desktop-
// install UI convenience (which dev server to default the accounts picker
// to), not server-authoritative state — same convention as
// landing-preflight-dismissal.ts's dismissal record. Scoped per runtime
// environment id since different environments can expose different dev
// server rosters.
const STORAGE_PREFIX = 'orca.accountsDevServer.'

export type AccountsDevServerOption = { id: string; name: string; status: string }

export type AccountsDevServerConnectionResolution = {
  connected: boolean
  connectionId: string
}

function storageKey(environmentId: string): string {
  return `${STORAGE_PREFIX}${environmentId}`
}

export function getPreferredAccountsDevServerId(environmentId: string): string | null {
  try {
    return localStorage.getItem(storageKey(environmentId)) || null
  } catch {
    return null
  }
}

export function setPreferredAccountsDevServerId(
  environmentId: string,
  devServerId: string | null
): void {
  try {
    if (devServerId) {
      localStorage.setItem(storageKey(environmentId), devServerId)
    } else {
      localStorage.removeItem(storageKey(environmentId))
    }
  } catch {
    // Why: a blocked storage write shouldn't crash the picker; the in-memory
    // selection still works for the rest of the session.
  }
}

export async function listAccountsDevServers(
  target: RuntimeClientTarget
): Promise<AccountsDevServerOption[]> {
  const list = await callRuntimeRpc<AccountsDevServerOption[]>(target, 'devServer.list', null)
  return list ?? []
}

// Resolves a chosen dev server to the connectionId accounts.* RPCs need,
// via accounts.resolveDevServerConnection (backend-go wscompat). Resolves
// fresh on every call rather than caching: accounts.* mutations are
// infrequent, user-initiated clicks, so the extra round trip is cheap next
// to inventing a cache-invalidation story for a value (live connection
// state) that can change at any moment — see TASK-023 for this tradeoff.
export async function resolveAccountsDevServerConnection(
  target: RuntimeClientTarget,
  devServerId: string
): Promise<AccountsDevServerConnectionResolution> {
  return callRuntimeRpc<AccountsDevServerConnectionResolution>(
    target,
    'accounts.resolveDevServerConnection',
    { devServerId }
  )
}

// FE-TASK-STORAGE-009: backend-go-backed mirror of the same environmentId ->
// devServerId preference above, keyed under a single `accountsDevServerMap`
// clientState record instead of per-environment localStorage keys. Separate
// from getPreferredAccountsDevServerId/setPreferredAccountsDevServerId (kept
// untouched — see their own HIGH-risk fan-out through AccountsPane) so a
// caller that wants the backend-go-restorable read (new machine / cleared
// cache) opts in explicitly, rather than changing the sync API every
// existing caller depends on.
//
// localStorage stays the fast, synchronous-feeling read path (same storage
// key as getPreferredAccountsDevServerId, via storageKey()); the RPC map is
// consulted only when that key is missing, e.g. right after a fresh
// install/browser-data-clear on a device that already picked a dev server
// from another one.
export async function getDefaultDevServerForEnvironment(
  environmentId: string
): Promise<string | null> {
  const local = getPreferredAccountsDevServerId(environmentId)
  if (local) {
    return local
  }
  const map = await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')
  return map?.[environmentId] ?? null
}

export async function setDefaultDevServerForEnvironment(
  environmentId: string,
  devServerId: string
): Promise<void> {
  setPreferredAccountsDevServerId(environmentId, devServerId)
  // Why read-merge-write, not a blind overwrite: `accountsDevServerMap` is one
  // shared record for every environment this user has picked a dev server
  // for — writing only { [environmentId]: devServerId } would drop every
  // other environment's entry already stored there.
  const map = (await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')) ?? {}
  await runtimeClientState.set('accountsDevServerMap', { ...map, [environmentId]: devServerId })
}

// Shared by every accounts.* mutation/subscribe call site — resolves the
// user's picked dev server all the way to a live connectionId, or throws a
// user-legible error before any accounts.* RPC is attempted (never send a
// request already known to fail with ACCOUNTS_NO_CONNECTION).
export async function requireAccountsDevServerConnectionId(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
): Promise<string> {
  const devServerId = getPreferredAccountsDevServerId(target.environmentId)
  if (!devServerId) {
    throw new Error('Pick a dev server in Settings > Accounts before managing provider accounts.')
  }
  const resolution = await resolveAccountsDevServerConnection(target, devServerId)
  if (!resolution.connected) {
    throw new Error('The selected dev server is not currently connected.')
  }
  return resolution.connectionId
}
