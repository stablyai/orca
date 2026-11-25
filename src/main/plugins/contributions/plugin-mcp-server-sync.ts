// Keeps the host's MCP server list in step with the servers approved plugins add, while the host's
// MCP servers switch is on. With it off, nothing here reads or writes the list.
import { pluginMcpServerTool } from '../../../shared/plugins/contributions/plugin-mcp-server-contribution'
import type { PluginChangeEvent } from '../../../shared/plugins/events/plugin-change-event'
import { isMcpServersFeatureEnabled } from '../../mcp-servers/mcp-servers-feature'
import type { PluginActivationState } from '../../../shared/plugins/approval/plugin-consent-state'
import {
  syncPluginMcpServers,
  type PluginMcpServers
} from '../../mcp-servers/mcp-plugin-server-sync'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../discovery/plugin-discovery'
import { onPluginRemoved } from '../installation/plugin-removal-events'

const RETRY_BASE_MS = 30_000
const RETRY_MAX_MS = 15 * 60_000

type PluginSource = {
  whenReady(): Promise<void>
  onChanged(listener: (event: PluginChangeEvent) => void): () => void
  getDiscovered(): readonly DiscoveredPlugin[]
  findApprovedPlugin(pluginKey: string): ValidDiscoveredPlugin | null
  activationState(plugin: ValidDiscoveredPlugin): PluginActivationState
  options: { getPluginConsents(): Record<string, string> }
}

/**
 * Every server an enabled, approved plugin adds. A plugin whose recorded approval names an earlier
 * version (an update installs before its approval carries over or is asked for) is held, not
 * dropped; a disabled, blocked, uninstalled, revoked or unverified one adds nothing.
 */
export function pluginMcpServers(service: PluginSource): PluginMcpServers {
  const held = new Set<string>()
  const consents = service.options.getPluginConsents()
  const declared = service.getDiscovered().flatMap((plugin) => {
    if (isInvalidDiscoveredPlugin(plugin)) {
      return []
    }
    const approved = service.findApprovedPlugin(plugin.pluginKey)
    if (!approved) {
      if (service.activationState(plugin) === 'pending' && plugin.pluginKey in consents) {
        held.add(plugin.pluginKey)
      }
      return []
    }
    return approved.manifest.contributes.mcpServers.map((contribution) => ({
      pluginKey: approved.pluginKey,
      pluginName: approved.manifest.name,
      server: pluginMcpServerTool(contribution)
    }))
  })
  return { declared, held }
}

/**
 * Syncs after each plugin refresh (startup's first one included) and uninstall; `changed` tells
 * clients when a sync wrote. One sync at a time: a request during one cancels its unwritten
 * snapshot, so a plugin disabled meanwhile is never written back, and runs once more after it.
 */
export function installPluginMcpServerSync(
  service: PluginSource,
  changed: () => void,
  log: (message: string) => void = console.warn
): () => void {
  let running: AbortController | null = null
  let again = false
  // Why retry: only plugin changes start a sync, so a failed removal would otherwise stay put.
  let failures = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  const sync = async (): Promise<void> => {
    if (!isMcpServersFeatureEnabled()) {
      return
    }
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    if (running) {
      again = true
      running.abort()
      return
    }
    try {
      do {
        again = false
        const run = new AbortController()
        running = run
        // Why after settling: mid-refresh nothing reads as approved, which would drop every server.
        await service.whenReady()
        try {
          if (await syncPluginMcpServers(pluginMcpServers(service), { signal: run.signal })) {
            changed()
          }
          failures = 0
        } catch (error) {
          log(`[mcp-servers] could not sync plugin servers: ${String(error)}`)
          failures += 1
        }
      } while (again)
    } finally {
      running = null
    }
    if (failures > 0) {
      retry = setTimeout(
        () => void sync(),
        Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS)
      )
      retry.unref?.()
    }
  }
  // Why only content changes: worker starts and stops change nothing a plugin declares.
  const stopChanges = service.onChanged((event) => {
    if (event.contentPacksChanged) {
      void sync()
    }
  })
  const stopRemovals = onPluginRemoved(() => void sync())
  return () => {
    if (retry) {
      clearTimeout(retry)
    }
    stopChanges()
    stopRemovals()
  }
}
