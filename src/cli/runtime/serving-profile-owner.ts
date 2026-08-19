import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { RuntimeRpcFailure } from '../../shared/runtime-rpc-envelope'
import type { CliStatusResult } from '../../shared/runtime-types'
import { probeRuntimeListener, type RuntimeListenerProbe } from './runtime-listener-probe'

/** How the owner proved it is alive, strongest first; `endpoint-held` never proved it. */
export type ServingProfileOwnerEvidence = 'rpc' | 'listening' | 'endpoint-held'

export type ServingProfileOwner = {
  pid: number | null
  evidence: ServingProfileOwnerEvidence
}

/**
 * Why: the "one Orca per profile" rule lives in the Electron main, past the
 * NSApplication init that aborts pre-JS when Launch Services is unreachable
 * (STA-4336) — so the CLI has to decide before the exec.
 *
 * Ownership is asserted on a runtime answering for itself, and also when the endpoint
 * neither answers nor disowns itself: only a definitive refusal frees the profile, the
 * same rule `orca status` applies to pids. A recycled pid would otherwise refuse forever.
 */
export async function findServingProfileOwner(
  status: CliStatusResult,
  metadata: RuntimeMetadata | null,
  probeListener: (metadata: RuntimeMetadata) => Promise<RuntimeListenerProbe> = probeRuntimeListener
): Promise<ServingProfileOwner | null> {
  const pid = status.app.pid ?? metadata?.pid ?? null
  if (status.runtime.reachable) {
    return { pid, evidence: 'rpc' }
  }
  if (!metadata) {
    return null
  }
  const probe = await probeListener(metadata)
  if (probe === 'not-listening') {
    return null
  }
  return { pid, evidence: probe === 'accepting' ? 'listening' : 'endpoint-held' }
}

/** Why: name the owner and the next step that applies to it — a refusal the user cannot act on is worse than the duplicate. */
export function serveAlreadyRunningMessage(owner: ServingProfileOwner): string {
  const who = owner.pid === null ? 'another process' : `pid ${owner.pid}`
  const lead = `[serve] Orca is already running for this userData profile as ${who}`
  if (owner.evidence === 'rpc') {
    return `${lead}; not starting a second process. Run \`orca status\` to inspect it, or stop it before serving again.`
  }
  if (owner.evidence === 'listening') {
    return `${lead} — its socket is accepting connections but it is not answering \`orca status\` yet; not starting a second process. Wait for it to finish starting, or stop it before serving again.`
  }
  return `${lead} — its socket neither accepted nor refused a connection, so this profile cannot be shown to be free; not starting a second process. Stop that process, or delete orca-runtime.json from this profile if nothing owns it.`
}

/**
 * Why: `--json` callers parse stdout. A refusal that only writes prose to stderr
 * looks to them like a serve that produced nothing.
 */
export function serveAlreadyRunningFailure(owner: ServingProfileOwner): RuntimeRpcFailure {
  return {
    id: 'local',
    ok: false,
    error: {
      code: 'runtime_serve_already_running',
      message: serveAlreadyRunningMessage(owner),
      data: { pid: owner.pid, evidence: owner.evidence }
    },
    _meta: { runtimeId: null }
  }
}
