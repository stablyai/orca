import { WORKSPACE_ON_OTHER_RUNTIME } from '../../../src/shared/protocol-version'
import {
  FALLBACK_MOBILE_SYSTEM_MONITOR_IDS,
  resolveSystemMonitorDescriptors,
  type SystemMonitorDescriptor
} from '../../../src/shared/system-monitors'
import { isMobileMethodUnavailableError } from '../transport/mobile-method-unavailable'
import type { RpcClient } from '../transport/rpc-client'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { MobileWorkspaceOnOtherRuntimeError } from './mobile-new-tab-agent-loader'
import { preflightDetectMonitorsRead } from './mobile-session-read-operations'

const SYSTEM_MONITORS_CACHE_MAX = 64
const cachedMonitorsByTarget = new Map<string, SystemMonitorDescriptor[]>()

export function resetMobileSystemMonitorsCacheForTests(): void {
  cachedMonitorsByTarget.clear()
}

export function getCachedMobileSystemMonitors(
  hostId: string,
  workspaceKey: string
): SystemMonitorDescriptor[] | null {
  return cachedMonitorsByTarget.get(`${hostId}\u0000${workspaceKey}`) ?? null
}

export function setCachedMobileSystemMonitors(
  hostId: string,
  workspaceKey: string,
  monitors: SystemMonitorDescriptor[]
): void {
  const key = `${hostId}\u0000${workspaceKey}`
  if (cachedMonitorsByTarget.size >= SYSTEM_MONITORS_CACHE_MAX && !cachedMonitorsByTarget.has(key)) {
    const oldestKey = cachedMonitorsByTarget.keys().next().value
    if (oldestKey !== undefined) {
      cachedMonitorsByTarget.delete(oldestKey)
    }
  }
  cachedMonitorsByTarget.set(key, monitors)
}

export function deleteCachedMobileSystemMonitors(hostId: string, workspaceKey: string): void {
  cachedMonitorsByTarget.delete(`${hostId}\u0000${workspaceKey}`)
}

export type LoadMobileSystemMonitorsResult = {
  monitors: SystemMonitorDescriptor[]
  fallback: boolean
}

export async function loadMobileSystemMonitors(args: {
  client: RpcClient
  worktreeId: string
}): Promise<LoadMobileSystemMonitorsResult> {
  const { client, worktreeId } = args
  const params = isFloatingWorkspaceWorktreeId(worktreeId) ? {} : { worktreeId }
  const reply = await preflightDetectMonitorsRead.request(client, params)
  if (!reply.ok && isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
    return {
      monitors: resolveSystemMonitorDescriptors(FALLBACK_MOBILE_SYSTEM_MONITOR_IDS),
      fallback: true
    }
  }
  try {
    const rawIds = preflightDetectMonitorsRead.interpret(reply)
    return {
      monitors: resolveSystemMonitorDescriptors(rawIds),
      fallback: false
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes(WORKSPACE_ON_OTHER_RUNTIME)) {
      throw new MobileWorkspaceOnOtherRuntimeError()
    }
    throw error
  }
}
