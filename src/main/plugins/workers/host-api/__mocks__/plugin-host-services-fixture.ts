import { vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../../shared/plugins/capabilities/plugin-capabilities'
import { executePluginHostCall } from '../plugin-host-methods'
import type { PluginHostServices } from '../plugin-host-method-bindings'
import type { PluginAuditLog } from '../../../plugin-audit-log'

/** Host services with inert stores and the given runtime RPC; `overrides` replaces any of them. */
export function pluginHostTestServices(
  runtimeRpc: PluginHostServices['runtimeRpc'],
  overrides: Partial<PluginHostServices> = {}
): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn().mockReturnValue([]) },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn(),
      protection: vi.fn().mockReturnValue('unavailable')
    },
    settings: { getAll: vi.fn().mockReturnValue({}), set: vi.fn().mockReturnValue({ ok: true }) },
    runtimeRpc,
    ...overrides
  }
}

/** A worker's call through the one chokepoint every transport uses, with an audit sink. */
export function callPluginHost(input: {
  method: string
  params: unknown
  granted: PluginCapabilityKind[]
  services: PluginHostServices
  audit?: Pick<PluginAuditLog, 'record'>
}) {
  return executePluginHostCall({
    pluginId: 'samples.demo',
    method: input.method,
    params: input.params,
    surface: 'worker',
    grantedCapabilities: input.granted,
    services: input.services,
    audit: input.audit ?? { record: vi.fn().mockResolvedValue(undefined) }
  })
}
