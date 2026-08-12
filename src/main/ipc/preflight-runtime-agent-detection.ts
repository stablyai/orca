import { getCanonicalUserDataPath } from '../persistence'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

/**
 * Probe agents installed on a paired runtime environment (host-side proxy for
 * mobile). Always invokes plain `preflight.detectAgents` on the target so a
 * remote host cannot re-delegate and form a loop.
 */
export async function detectRuntimeAgents(args: { environmentId: string }): Promise<string[]> {
  const environmentId = args.environmentId.trim()
  if (!environmentId) {
    return []
  }
  try {
    const userDataPath = getCanonicalUserDataPath()
    // Why: only environments registered on this host are addressable — unknown
    // ids fail closed before any network hop.
    resolveEnvironment(userDataPath, environmentId)
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'preflight.detectAgents',
      undefined
    )
    if (response.ok !== true) {
      // Why: passive UI polling — a disconnected runtime has no detectable
      // agents until reconnect, but should not spam RPC errors.
      return []
    }
    return uniqueAgentIds(response.result)
  } catch {
    return []
  }
}

function uniqueAgentIds(result: unknown): string[] {
  if (!Array.isArray(result)) {
    return []
  }
  const ids = result.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0
  )
  return [...new Set(ids)]
}
