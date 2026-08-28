import type { RuntimeCapability } from '../../../../shared/protocol-version'
import { AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/runtime-types'

type SessionTabsPayload = RuntimeMobileSessionTabsResult | RuntimeMobileSessionTabsSnapshot

export function projectSessionTabAgentStatus<TPayload extends SessionTabsPayload>(
  payload: TPayload,
  clientKind: 'mobile' | 'runtime' | undefined,
  clientCapabilities: readonly RuntimeCapability[] | undefined
): TPayload {
  // Why: only paired runtimes have legacy `done` completion side effects; mobile must keep its row without changing the exact v2 auth shape.
  if (
    clientKind !== 'runtime' ||
    clientCapabilities?.includes(AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY)
  ) {
    return payload
  }

  let changed = false
  const tabs = payload.tabs.map((tab) => {
    if (tab.type !== 'terminal' || !tab.agentStatus?.sessionBoundary) {
      return tab
    }
    changed = true
    const { agentStatus: _boundary, ...legacyTab } = tab
    return legacyTab
  })
  return changed ? ({ ...payload, tabs } as TPayload) : payload
}
