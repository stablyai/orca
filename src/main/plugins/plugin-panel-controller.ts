import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../../shared/plugins/plugin-panel-bridge'
import {
  panelActionCallSchema,
  panelLiveAttachCallSchema,
  panelLiveMessageCallSchema,
  type PanelLiveMessageDelivery
} from '../../shared/plugins/plugin-panel-bridge'
import {
  normalizePanelLiveMessage,
  PANEL_LIVE_MESSAGE_MAX_BYTES,
  PANEL_LIVE_MESSAGE_RATE_LIMIT
} from '../../shared/plugins/plugin-panel-live-message'
import {
  admitPluginPanelCall,
  createPluginPanelCallAdmission,
  type PluginPanelCallAdmission
} from '../../shared/plugins/plugin-panel-call-admission'
import { buildPluginPanelShellHtml } from '../../shared/plugins/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { PluginPanelSessions, type PluginPanelSessionBinding } from './plugin-panel-sessions'
import { PluginPanelMounts } from './plugin-panel-mounts'

type PluginPanelControllerOptions = {
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  contentVerifier: Pick<PluginContentVerifier, 'verify'>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown
  ) => Promise<PluginPanelActionOutcome>
  log: (pluginKey: string) => (line: string) => void
  panelAdmission?: PluginPanelCallAdmission
  /** Hands a normalized live panel message to the owning plugin's worker. */
  deliverToWorker?: (
    pluginKey: string,
    panelId: string,
    message: unknown
  ) => Promise<PluginPanelActionOutcome>
  /** Worker → panel budget; defaults to PANEL_LIVE_MESSAGE_RATE_LIMIT. */
  liveAdmission?: PluginPanelCallAdmission
}

type SessionCallAdmission =
  | { ok: true; binding: PluginPanelSessionBinding }
  | { ok: false; outcome: PluginPanelActionOutcome }

type LoadedPluginPanel = {
  entry: { html: string }
  binding: PluginPanelSessionBinding
}

export class PluginPanelController {
  private readonly sessions = new PluginPanelSessions()
  private readonly mounts = new PluginPanelMounts()
  private readonly boundOwnerSignals = new WeakSet<AbortSignal>()
  private readonly panelAdmission: PluginPanelCallAdmission
  private readonly liveAdmission: PluginPanelCallAdmission

  constructor(private readonly options: PluginPanelControllerOptions) {
    this.panelAdmission = options.panelAdmission ?? createPluginPanelCallAdmission()
    this.liveAdmission =
      options.liveAdmission ??
      createPluginPanelCallAdmission({
        limits: { maxBytes: PANEL_LIVE_MESSAGE_MAX_BYTES, ...PANEL_LIVE_MESSAGE_RATE_LIMIT }
      })
  }

  async readEntry(pluginKey: string, panelId: string): Promise<{ html: string } | null> {
    return (await this.load(pluginKey, panelId))?.entry ?? null
  }

  async open(
    ownerKey: string,
    pluginKey: string,
    panelId: string
  ): Promise<PluginPanelEntry | null> {
    const loaded = await this.load(pluginKey, panelId)
    if (!loaded) {
      return null
    }
    return {
      ...loaded.entry,
      sessionToken: this.sessions.issue(ownerKey, loaded.binding)
    }
  }

  async execute(ownerKey: string, call: unknown): Promise<PluginPanelActionOutcome> {
    const admitted = this.admitSessionCall(ownerKey, call)
    if (!admitted.ok) {
      return admitted.outcome
    }
    const parsed = panelActionCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel action call' }
    }
    if (!this.currentPlugin(admitted.binding)) {
      return { ok: false, code: 'unavailable', error: 'panel session is no longer available' }
    }
    return this.options.executeHostCall(
      admitted.binding.pluginKey,
      parsed.data.action,
      parsed.data.params
    )
  }

  /** Panel → worker live message, routed by the session the host issued. */
  async receiveFromPanel(ownerKey: string, call: unknown): Promise<PluginPanelActionOutcome> {
    const admitted = this.admitSessionCall(ownerKey, call)
    if (!admitted.ok) {
      return admitted.outcome
    }
    const parsed = panelLiveMessageCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel message call' }
    }
    if (!this.currentPlugin(admitted.binding)) {
      return { ok: false, code: 'unavailable', error: 'panel session is no longer available' }
    }
    const normalized = normalizePanelLiveMessage(parsed.data.message)
    if (!normalized.ok) {
      return { ok: false, code: 'invalid_request', error: normalized.error }
    }
    if (!this.options.deliverToWorker) {
      return { ok: false, code: 'unavailable', error: 'panel messaging is not available' }
    }
    const { pluginKey, panelId } = admitted.binding
    return this.options.deliverToWorker(pluginKey, panelId, normalized.message)
  }

  /** A mounted frame starts receiving worker pushes for its session. */
  attach(
    ownerKey: string,
    call: unknown,
    deliver: (delivery: PanelLiveMessageDelivery) => void
  ): boolean {
    const parsed = panelLiveAttachCallSchema.safeParse(call)
    const binding = parsed.success
      ? this.sessions.resolve(ownerKey, parsed.data.sessionToken)
      : null
    if (!parsed.success || !binding || !this.currentPlugin(binding)) {
      return false
    }
    this.mounts.attach({ ownerKey, sessionToken: parsed.data.sessionToken, binding, deliver })
    return true
  }

  detach(ownerKey: string, call: unknown): void {
    const parsed = panelLiveAttachCallSchema.safeParse(call)
    if (parsed.success) {
      this.mounts.detach(ownerKey, parsed.data.sessionToken)
    }
  }

  /** Worker → panel: reaches only frames mounted under this plugin's own
   *  sessions for `panelId`; with none mounted the message is dropped. */
  postToPanel(
    pluginKey: string,
    panelId: string,
    message: unknown
  ): { ok: true; delivered: boolean } | { ok: false; error: string } {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    if (!plugin?.manifest.contributes.panels.some((panel) => panel.id === panelId)) {
      return { ok: false, error: `unknown panel: ${panelId}` }
    }
    const refusal = this.liveAdmission.admit(pluginKey, message)
    if (refusal) {
      return {
        ok: false,
        error:
          refusal === 'oversized'
            ? 'panel message exceeds the size limit'
            : 'too many panel messages'
      }
    }
    let delivered = false
    for (const mount of this.mounts.forPanel(pluginKey, panelId)) {
      // Why: sessions rotate on reload and are evicted; a stale frame must stop receiving.
      if (
        !this.sessions.resolve(mount.ownerKey, mount.sessionToken) ||
        !this.currentPlugin(mount.binding)
      ) {
        this.mounts.delete(mount.sessionToken)
        continue
      }
      mount.deliver({ sessionToken: mount.sessionToken, message })
      delivered = true
    }
    return { ok: true, delivered }
  }

  revokeOwner(ownerKey: string): void {
    this.sessions.revokeOwner(ownerKey)
    this.mounts.revokeOwner(ownerKey)
  }

  bindOwnerSignal(ownerKey: string, signal: AbortSignal | undefined): void {
    if (!signal || this.boundOwnerSignals.has(signal)) {
      return
    }
    this.boundOwnerSignals.add(signal)
    if (signal.aborted) {
      this.revokeOwner(ownerKey)
      return
    }
    signal.addEventListener('abort', () => this.revokeOwner(ownerKey), { once: true })
  }

  revokeAll(): void {
    this.sessions.clear()
    this.mounts.clear()
    this.panelAdmission.clear()
    this.liveAdmission.clear()
  }

  dispose(): void {
    this.revokeAll()
  }

  private admitSessionCall(ownerKey: string, call: unknown): SessionCallAdmission {
    const sessionToken = this.extractSessionToken(call)
    const binding = sessionToken ? this.sessions.resolve(ownerKey, sessionToken) : null
    if (!binding) {
      return {
        ok: false,
        outcome: { ok: false, code: 'invalid_request', error: 'invalid panel session' }
      }
    }
    const refusal = admitPluginPanelCall(this.panelAdmission, binding.pluginKey, call)
    return refusal ? { ok: false, outcome: refusal } : { ok: true, binding }
  }

  private currentPlugin(binding: PluginPanelSessionBinding): ValidDiscoveredPlugin | null {
    const plugin = this.options.resolveApprovedPlugin(binding.pluginKey)
    if (
      !plugin ||
      plugin.rootDir !== binding.rootDir ||
      JSON.stringify(plugin.manifest) !== binding.manifestRevision ||
      !plugin.manifest.contributes.panels.some((panel) => panel.id === binding.panelId)
    ) {
      return null
    }
    return plugin
  }

  private extractSessionToken(call: unknown): string | null {
    if (typeof call !== 'object' || call === null) {
      return null
    }
    try {
      const token = (call as { sessionToken?: unknown }).sessionToken
      return typeof token === 'string' && token.length >= 32 && token.length <= 128 ? token : null
    } catch {
      return null
    }
  }

  private async load(pluginKey: string, panelId: string): Promise<LoadedPluginPanel | null> {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    const panel = plugin?.manifest.contributes.panels.find((entry) => entry.id === panelId)
    if (!plugin || !panel) {
      return null
    }
    const log = this.options.log(pluginKey)
    try {
      await this.options.contentVerifier.verify(plugin)
      const html = buildPluginPanelShellHtml(
        await readContainedPluginArtifactText(
          plugin.rootDir,
          panel.entry,
          PLUGIN_PANEL_ENTRY_MAX_BYTES
        )
      )
      const current = this.options.resolveApprovedPlugin(pluginKey)
      if (current !== plugin || current.rootDir !== plugin.rootDir) {
        return null
      }
      return {
        entry: { html },
        binding: {
          pluginKey,
          panelId,
          rootDir: plugin.rootDir,
          manifestRevision: JSON.stringify(plugin.manifest)
        }
      }
    } catch (error) {
      log(
        `panel entry ${panel.entry} rejected: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }
}
