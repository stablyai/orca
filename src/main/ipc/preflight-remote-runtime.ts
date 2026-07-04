import { app } from 'electron'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'
import type { PreflightStatus, RefreshAgentsResult } from './preflight'

const REMOTE_RUNTIME_TIMEOUT_MS = 15_000

// Why: mirrors the web client's fallback so a transient remote failure surfaces
// "no agents" rather than an error — the agent picker treats an empty list as
// "nothing installed yet", which is the correct degraded state while remote.
const REMOTE_AGENT_REFRESH_FALLBACK: RefreshAgentsResult = {
  agents: [],
  addedPathSegments: [],
  shellHydrationOk: false,
  pathSource: 'sync_seed_only',
  pathFailureReason: 'spawn_error'
}

// Why: when connected to a remote Orca runtime, git/gh/glab are installed on the
// server, not the local client. Proxy to the server's preflight RPC so the check
// runs against the correct filesystem and shell. Fail loud on error rather than
// falling back to the local scan, which would surface misleading local status
// while remote — mirrors the web client.
export async function checkPreflightViaRemoteRuntime(
  environmentId: string,
  force: boolean | undefined
): Promise<PreflightStatus> {
  const response = await callRuntimeEnvironment(
    app.getPath('userData'),
    environmentId,
    'preflight.check',
    { force },
    REMOTE_RUNTIME_TIMEOUT_MS
  ).catch((error: unknown) => {
    // Why: an unreachable host rejects rather than resolving ok:false.
    console.warn('[preflight] remote check unavailable:', error)
    throw error
  })
  if (response.ok) {
    return response.result as PreflightStatus
  }
  console.warn('[preflight] remote check failed:', response.error.message)
  throw new Error(response.error.message)
}

// Why: while a remote runtime is active the AI CLIs are installed on the server,
// not the local client. Proxy detection to the server's RPC; on any failure
// surface the empty fallback rather than the local list (which would mislabel
// the remote) — mirrors the web client's preflight.detectAgents behavior.
export async function detectAgentsViaRemoteRuntime(environmentId: string): Promise<string[]> {
  try {
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      environmentId,
      'preflight.detectAgents',
      undefined,
      REMOTE_RUNTIME_TIMEOUT_MS
    )
    if (response.ok) {
      return response.result as string[]
    }
    console.warn('[preflight] remote agent detection failed:', response.error.message)
  } catch (error) {
    // Why: an unreachable host rejects rather than resolving ok:false.
    console.warn('[preflight] remote agent detection unavailable:', error)
  }
  return []
}

export async function refreshAgentsViaRemoteRuntime(
  environmentId: string
): Promise<RefreshAgentsResult> {
  try {
    const response = await callRuntimeEnvironment(
      app.getPath('userData'),
      environmentId,
      'preflight.refreshAgents',
      undefined,
      REMOTE_RUNTIME_TIMEOUT_MS
    )
    if (response.ok) {
      return response.result as RefreshAgentsResult
    }
    console.warn('[preflight] remote agent refresh failed:', response.error.message)
  } catch (error) {
    // Why: an unreachable host rejects rather than resolving ok:false.
    console.warn('[preflight] remote agent refresh unavailable:', error)
  }
  return REMOTE_AGENT_REFRESH_FALLBACK
}
