/** How a managed-server setup that did not finish ends: with SSH's own reason, or as an unserved status. */
import type { SshTarget } from '../../shared/ssh-types'
import type {
  HostServerOnConnectDeps,
  HostServerOnConnectResult
} from './ssh-host-server-on-connect'
import { orcadMigrationConflictGuidance } from './orcad-migration-conflict-guidance'
import { boundedDetail, setupFailure, type SetupFailure } from './ssh-host-server-setup-failure'
import { isSshSessionStartFailure } from './ssh-session-start-failure'
import { classifyOrcadHostUnavailable } from '../orcad/orcad-host-unavailable'
import {
  reportHostServerSetupError,
  type HostServerDecisionTrace
} from './ssh-host-server-connect-events'

export function setupFailed(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  trace: HostServerDecisionTrace,
  error: unknown,
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn('[ssh] Managed Orca server setup failed:', error)
  reportHostServerSetupError(deps.report, target, trace, error)
  if (isSshSessionStartFailure(error)) {
    return sshSessionStartFailed(target, deps, empty, error)
  }
  const unavailable = classifyOrcadHostUnavailable(error)
  const conflict = empty ? null : orcadMigrationConflictGuidance(error)
  if (conflict) {
    return unfinished(target, deps, unavailable, empty, 'refused', { detail: conflict })
  }
  return unfinished(target, deps, unavailable, empty, 'failed', setupFailure(error))
}

/** SSH never connected, so nothing was learned about the server: fail the connect with SSH's reason. */
async function sshSessionStartFailed(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  empty: boolean,
  error: unknown
): Promise<HostServerOnConnectResult> {
  const result = await unfinished(target, deps, null, empty, 'failed', setupFailure(error))
  // A held move keeps its own status, which offers the way to finish or undo it.
  if (result.route === 'unserved' && result.held) {
    return result
  }
  throw error
}

export function deferred(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  result: { code: string; reason: string },
  empty: boolean
): Promise<HostServerOnConnectResult> {
  console.warn(`[ssh] Managed Orca server setup deferred (${result.code}):`, result.reason)
  const unavailable = classifyOrcadHostUnavailable({ code: result.code })
  return unfinished(target, deps, unavailable, empty, 'deferred', { detail: result.reason })
}

/** Release failed setup claims/fences only with absence proof; record definitive host incompatibility separately. */
async function unfinished(
  target: SshTarget,
  deps: HostServerOnConnectDeps,
  unavailable: string | null,
  empty: boolean,
  reason: 'deferred' | 'failed' | 'refused',
  failure: SetupFailure
): Promise<HostServerOnConnectResult> {
  try {
    await (empty ? deps.abandonDeploy(target) : deps.abandonConversion(target))
  } catch (error) {
    // Retain fences when staging/registration leaves destination state unproven.
    console.warn('[ssh] The managed Orca server setup keeps its fence:', error)
  }
  // Re-read the journal: abort may have released the fence or discovered commit.
  const held = !empty && !unavailable && deps.hasUnfinishedConversion(target)
  if (!unavailable) {
    // Publish host-specific setup detail, including bounded orcad.log tail when available.
    return {
      route: 'unserved',
      reason,
      detail: boundedDetail(failure.detail),
      ...(failure.contactLost ? { contactLost: true as const } : {}),
      ...(failure.nodeDownloadBlocked ? { nodeDownloadBlocked: failure.nodeDownloadBlocked } : {}),
      ...(held ? { held: true as const } : {})
    }
  }
  deps.recordUnavailable(target, unavailable)
  return { route: 'unserved', reason: 'orcad_unavailable', detail: unavailable }
}
