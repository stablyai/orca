import { getStatusPluginEndpointSource } from './status-plugin-endpoint-source'
import { getStatusPluginRuntimeStateSource } from './status-plugin-runtime-state-source'
import { getStatusPluginMessagePreviewSource } from './status-plugin-message-preview-source'
import { getStatusPluginSessionLineageSource } from './status-plugin-session-lineage-source'
import { getStatusPluginPostSource } from './status-plugin-post-source'
import { getStatusPluginDeliverySource } from './status-plugin-delivery-source'
import { getStatusPluginOwnershipSource } from './status-plugin-ownership-source'
import { getStatusPluginLifecycleSource } from './status-plugin-lifecycle-source'
import { getStatusPluginFactorySource } from './status-plugin-factory-source'

// Both major versions install as `opencode`; let the loader choose server() or setup().
export function getOpenCodePluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode', {
    emitSessionStart: true,
    emitNextEvents: true,
    expectedAgent: 'opencode'
  })
}

export function getOpenCode2PluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode2', {
    emitSessionStart: true,
    emitNextEvents: true
  })
}

export function getOpenCodeFamilyPluginSource(
  hookPathname: string,
  options: {
    emitSessionStart: boolean
    emitNextEvents?: boolean
    expectedAgent?: 'opencode' | 'opencode2'
  }
): string {
  // Why: the plugin posts PTY environment data from OpenCode to the shared hooks server.
  return [
    ...getStatusPluginEndpointSource(),
    ...getStatusPluginRuntimeStateSource(),
    ...getStatusPluginMessagePreviewSource(),
    ...getStatusPluginSessionLineageSource(),
    ...getStatusPluginPostSource(hookPathname),
    ...getStatusPluginDeliverySource(),
    ...getStatusPluginOwnershipSource(),
    ...getStatusPluginLifecycleSource(),
    ...getStatusPluginFactorySource(options)
  ].join('\n')
}
