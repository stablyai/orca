import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../shared/plugins/plugin-events'
import type { PluginEventName } from '../../shared/plugins/plugin-manifest'

/**
 * Server-side event filtering: plugins receive only events they subscribed
 * to (manifest `contributes.events` or a runtime `events.subscribe` call) —
 * never a firehose. Manifest subscriptions are durable activation triggers;
 * dynamic subscriptions live only as long as the worker that made them.
 */

export class PluginEventBus {
  private readonly dynamicSubscriptions = new Map<string, Set<PluginEventName>>()

  subscribe(pluginKey: string, events: PluginEventName[]): PluginEventName[] {
    const existing = this.dynamicSubscriptions.get(pluginKey) ?? new Set<PluginEventName>()
    for (const event of events) {
      existing.add(event)
    }
    this.dynamicSubscriptions.set(pluginKey, existing)
    return [...existing]
  }

  isDynamicallySubscribed(pluginKey: string, event: PluginEventName): boolean {
    return this.dynamicSubscriptions.get(pluginKey)?.has(event) ?? false
  }

  /** Dynamic subscriptions die with the worker that registered them. */
  clear(pluginKey: string): void {
    this.dynamicSubscriptions.delete(pluginKey)
  }

  /** Validates and bounds an event payload before it reaches any plugin. */
  projectPayload(
    event: PluginEventName,
    payload: unknown
  ): { ok: true; payload: unknown } | { ok: false; error: string } {
    const parsed = PLUGIN_EVENT_PAYLOAD_SCHEMAS[event].safeParse(payload)
    return parsed.success
      ? { ok: true, payload: parsed.data }
      : { ok: false, error: `malformed ${event} payload` }
  }
}
