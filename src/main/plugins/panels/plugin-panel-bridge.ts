import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import { PLUGIN_EVENT_CAPABILITY } from '../../../shared/plugins/contributions/plugin-event-contribution'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_EVENT_PAYLOAD_SCHEMAS } from '../../../shared/plugins/events/plugin-events'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../shared/plugins/frames/plugin-panel-message-budget'
import {
  PLUGIN_PANEL_POST_MAX_BYTES,
  PLUGIN_PANEL_POST_RATE_LIMIT,
  PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS,
  PLUGIN_PANEL_RESULT_MAX_BYTES,
  type PluginDataArea,
  type PluginPanelCaller,
  type PluginPanelPush,
  type PluginWorkerPanelPost
} from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'
import { normalizePluginErrorCode } from '../../../shared/plugins/frames/plugin-protocol'
import type { PluginJsonValue } from '../../../shared/plugins/workers/plugin-host-api'
import { z } from 'zod'

const PLUGIN_JSON_VALUE = z.json()
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { PluginHostCallError } from '../workers/plugin-host-call-scope'
import type { PluginRuntimeDelegate } from '../workers/plugin-host-service-bindings'
import { readPluginWorkspaceChange } from '../plugin-runtime-binding'

type PushChannel = {
  pluginKey: string
  deliver: (push: PluginPanelPush) => void
}

export type PluginPanelBridgeDependencies = {
  findApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  grantedCapabilities: (pluginKey: string) => readonly PluginCapabilityKind[] | null
  ensureWorker: (plugin: ValidDiscoveredPlugin) => Promise<PluginWorkerHandle>
  runningWorker: (pluginKey: string) => PluginWorkerHandle | null
  log: (pluginKey: string) => (line: string) => void
  /** For replaying the current workspace to a panel that subscribes to `workspace.changed`. */
  runtimeDelegate?: () => PluginRuntimeDelegate | null
  now?: () => number
}

export type PluginPanelRequest = {
  pluginKey: string
  caller: PluginPanelCaller
  name: string
  input: unknown
  timeoutMs?: number
  /** Replaces the panel session's lifetime for callers that are not an open panel. */
  signal?: AbortSignal
}

/**
 * A plugin's open panels and its own worker. Requests go panel → worker and back; pushes (worker
 * posts, events, data changes) go to the panels whose renderer opened a channel. One open panel is
 * one session: its id names it to the worker, and closing it aborts its requests.
 */
export class PluginPanelBridge {
  private readonly channels = new Map<string, PushChannel>()
  private readonly lifetimes = new Map<string, AbortController>()
  private readonly postBudgets = new Map<string, PanelMessageBudget>()
  // By panel, not channel: a frame may subscribe before its renderer opens the channel.
  private readonly subscriptions = new Map<string, Set<PluginEventName>>()
  // Subscriptions still owed their current state, delivered once the panel's channel is open.
  private readonly replays = new Map<string, Set<PluginEventName>>()

  constructor(private readonly deps: PluginPanelBridgeDependencies) {}

  /** A renderer listens to one open panel; the returned function stops it. */
  open(caller: PluginPanelCaller, pluginKey: string, deliver: PushChannel['deliver']): () => void {
    const channel: PushChannel = { pluginKey, deliver }
    this.channels.set(caller.id, channel)
    void this.replay(caller.id)
    return () => {
      if (this.channels.get(caller.id) === channel) {
        this.channels.delete(caller.id)
      }
    }
  }

  /** The session ended: its channel goes and its in-flight requests see `signal` abort. */
  close(panelId: string): void {
    this.channels.delete(panelId)
    this.subscriptions.delete(panelId)
    this.replays.delete(panelId)
    this.lifetimes.get(panelId)?.abort()
    this.lifetimes.delete(panelId)
  }

  subscribe(pluginKey: string, panelId: string, event: PluginEventName): void {
    const required = PLUGIN_EVENT_CAPABILITY[event]
    if (!this.deps.grantedCapabilities(pluginKey)?.includes(required)) {
      throw new PluginHostCallError(
        'capability_denied',
        `plugin does not have the "${required}" capability`
      )
    }
    const events = this.subscriptions.get(panelId) ?? new Set<PluginEventName>()
    events.add(event)
    this.subscriptions.set(panelId, events)
    // Why: a panel that subscribes after the last change (or before Orca focused a workspace)
    // would otherwise show nothing until the next one.
    if (event === 'workspace.changed') {
      const owed = this.replays.get(panelId) ?? new Set<PluginEventName>()
      owed.add(event)
      this.replays.set(panelId, owed)
      void this.replay(panelId)
    }
  }

  /** Delivers the current state for each subscription still owed it, once the channel is open. */
  private async replay(panelId: string): Promise<void> {
    const channel = this.channels.get(panelId)
    const owed = this.replays.get(panelId)
    const delegate = this.deps.runtimeDelegate?.()
    if (!channel || !owed || !delegate) {
      return
    }
    this.replays.delete(panelId)
    for (const event of owed) {
      const payload = await readPluginWorkspaceChange(delegate)
      if (
        this.channels.get(panelId) === channel &&
        this.subscriptions.get(panelId)?.has(event) &&
        this.deps.grantedCapabilities(channel.pluginKey)?.includes(PLUGIN_EVENT_CAPABILITY[event])
      ) {
        channel.deliver({ kind: 'event', event, payload })
      }
    }
  }

  /** Whether an open panel subscribed to `event`. */
  hasSubscribers(event: PluginEventName): boolean {
    return [...this.channels.keys()].some((panelId) => this.subscriptions.get(panelId)?.has(event))
  }

  async request(request: PluginPanelRequest): Promise<PluginJsonValue> {
    const plugin = this.deps.findApprovedPlugin(request.pluginKey)
    if (!plugin?.manifest.main) {
      throw new PluginHostCallError('unavailable', 'this plugin has no worker to answer requests')
    }
    let worker: PluginWorkerHandle
    try {
      worker = await this.deps.ensureWorker(plugin)
    } catch (error) {
      throw new PluginHostCallError('unavailable', errorText(error))
    }
    let output: unknown
    try {
      output = await worker.requestFromPanel({
        name: request.name,
        input: request.input,
        panel: request.caller,
        timeoutMs: request.timeoutMs ?? PLUGIN_PANEL_REQUEST_DEFAULT_TIMEOUT_MS,
        signal: request.signal ?? this.lifetime(request.caller.id).signal
      })
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : null
      throw new PluginHostCallError(normalizePluginErrorCode(code), errorText(error))
    }
    if (
      structuredCloneMessageBytes(output ?? null, PLUGIN_PANEL_RESULT_MAX_BYTES) >
      PLUGIN_PANEL_RESULT_MAX_BYTES
    ) {
      throw new PluginHostCallError('too_large', `${request.name} answered with more than 1 MiB`)
    }
    const json = PLUGIN_JSON_VALUE.safeParse(output ?? null)
    if (!json.success) {
      throw new PluginHostCallError(
        'action_failed',
        `${request.name} answered with a non-JSON value`
      )
    }
    return json.data
  }

  /** `orca.panels.post`: dropped (and logged) past the plugin's size and rate budget. */
  onWorkerPost(pluginKey: string, post: PluginWorkerPanelPost): void {
    const budget = this.postBudget(pluginKey)
    const bytes = structuredCloneMessageBytes(post.payload ?? null, PLUGIN_PANEL_POST_MAX_BYTES)
    const refusal = budget.admit(this.deps.now?.() ?? Date.now(), bytes)
    if (refusal) {
      this.deps.log(pluginKey)(
        `orca.panels.post("${post.event}") dropped: ${refusal === 'oversized' ? 'payload over 256 KiB' : 'too many posts'}`
      )
      return
    }
    const push: PluginPanelPush = {
      kind: 'message',
      event: post.event,
      payload: post.payload ?? null
    }
    for (const [panelId, channel] of this.channels) {
      if (channel.pluginKey === pluginKey && (post.panel === undefined || post.panel === panelId)) {
        channel.deliver(push)
      }
    }
  }

  /** A projected workspace or agent event, to panels that subscribed and may read its domain. */
  /** Returns how many open panels heard it; `pluginKey` limits it to one plugin's panels. */
  publishEvent(event: PluginEventName, raw: unknown, only?: { pluginKey: string }): number {
    // Why: payloads are bounded projections, so a malformed one never reaches a panel.
    const projected = PLUGIN_EVENT_PAYLOAD_SCHEMAS[event].safeParse(raw)
    if (!projected.success) {
      return 0
    }
    const payload = projected.data
    const required = PLUGIN_EVENT_CAPABILITY[event]
    let delivered = 0
    for (const [panelId, channel] of this.channels) {
      if (
        (!only || channel.pluginKey === only.pluginKey) &&
        this.subscriptions.get(panelId)?.has(event) === true &&
        this.deps.findApprovedPlugin(channel.pluginKey) &&
        this.deps.grantedCapabilities(channel.pluginKey)?.includes(required)
      ) {
        channel.deliver({ kind: 'event', event, payload })
        delivered += 1
      }
    }
    return delivered
  }

  /** Storage or settings changed: open panels and a running worker re-read the key. */
  dataChanged(pluginKey: string, area: PluginDataArea, key: string): void {
    for (const channel of this.channels.values()) {
      if (channel.pluginKey === pluginKey) {
        channel.deliver({ kind: 'changed', area, key })
      }
    }
    this.deps.runningWorker(pluginKey)?.notifyDataChanged({ area, key })
  }

  dispose(): void {
    for (const id of this.lifetimes.keys()) {
      this.close(id)
    }
    this.channels.clear()
    this.postBudgets.clear()
  }

  private lifetime(panelId: string): AbortController {
    let controller = this.lifetimes.get(panelId)
    if (!controller) {
      controller = new AbortController()
      this.lifetimes.set(panelId, controller)
    }
    return controller
  }

  private postBudget(pluginKey: string): PanelMessageBudget {
    let budget = this.postBudgets.get(pluginKey)
    if (!budget) {
      budget = createPanelMessageBudget({
        ...PLUGIN_PANEL_POST_RATE_LIMIT,
        maxBytes: PLUGIN_PANEL_POST_MAX_BYTES
      })
      this.postBudgets.set(pluginKey, budget)
    }
    return budget
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
