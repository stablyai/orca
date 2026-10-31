import {
  panelActionCallSchema,
  type PluginFrameEntry
} from '../../../shared/plugins/frames/plugin-frame-bridge'
import type {
  PluginHostCallOutcome,
  PluginSurface
} from '../../../shared/plugins/frames/plugin-protocol'
import {
  admitPluginPanelCall,
  createPluginPanelCallAdmission,
  type PluginPanelCallAdmission
} from '../../../shared/plugins/frames/plugin-panel-call-admission'
import {
  buildPluginPanelShellHtml,
  type PluginFrameSurface
} from '../../../shared/plugins/frames/plugin-panel-shell'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginContentVerifier } from '../plugin-content-integrity'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText
} from '../plugin-artifact-validation'
import { PluginPanelSessions, type PluginPanelSessionBinding } from './plugin-panel-sessions'

type PluginPanelControllerOptions = {
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  contentVerifier: Pick<PluginContentVerifier, 'verify'>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown,
    surface: PluginSurface
  ) => Promise<PluginHostCallOutcome>
  log: (pluginKey: string) => (line: string) => void
  panelAdmission?: PluginPanelCallAdmission
}

type LoadedPluginPanel = {
  entry: { html: string }
  binding: PluginPanelSessionBinding
}

export class PluginPanelController {
  private readonly sessions = new PluginPanelSessions()
  private readonly boundOwnerSignals = new WeakSet<AbortSignal>()
  private readonly panelAdmission: PluginPanelCallAdmission

  constructor(private readonly options: PluginPanelControllerOptions) {
    this.panelAdmission = options.panelAdmission ?? createPluginPanelCallAdmission()
  }

  async readEntry(pluginKey: string, panelId: string): Promise<{ html: string } | null> {
    return (await this.load(pluginKey, 'panel', panelId))?.entry ?? null
  }

  open(
    ownerKey: string,
    pluginKey: string,
    panelId: string,
    isCurrent?: () => boolean
  ): Promise<PluginFrameEntry | null> {
    return this.openFrame(ownerKey, pluginKey, 'panel', panelId, isCurrent)
  }

  openCustomEditor(
    ownerKey: string,
    pluginKey: string,
    editorId: string,
    isCurrent?: () => boolean
  ): Promise<PluginFrameEntry | null> {
    return this.openFrame(ownerKey, pluginKey, 'editor', editorId, isCurrent)
  }

  async execute(ownerKey: string, call: unknown): Promise<PluginHostCallOutcome> {
    const sessionToken = this.extractSessionToken(call)
    if (!sessionToken) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    const binding = this.sessions.resolve(ownerKey, sessionToken)
    if (!binding) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    const admissionRefusal = admitPluginPanelCall(this.panelAdmission, binding.pluginKey, call)
    if (admissionRefusal) {
      return admissionRefusal
    }
    const parsed = panelActionCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel action call' }
    }
    const plugin = this.options.resolveApprovedPlugin(binding.pluginKey)
    if (
      !plugin ||
      plugin.rootDir !== binding.rootDir ||
      JSON.stringify(plugin.manifest) !== binding.manifestRevision ||
      !findFrameContribution(plugin, binding.surface, binding.contributionId)
    ) {
      return { ok: false, code: 'unavailable', error: 'panel session is no longer available' }
    }
    return this.options.executeHostCall(
      binding.pluginKey,
      parsed.data.action,
      parsed.data.params,
      binding.surface
    )
  }

  revokeOwner(ownerKey: string): void {
    this.sessions.revokeOwner(ownerKey)
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
    this.panelAdmission.clear()
  }

  dispose(): void {
    this.revokeAll()
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

  private async openFrame(
    ownerKey: string,
    pluginKey: string,
    surface: PluginPanelSessionBinding['surface'],
    contributionId: string,
    isCurrent?: () => boolean
  ): Promise<PluginFrameEntry | null> {
    if (isCurrent?.() === false) {
      return null
    }
    const loaded = await this.load(pluginKey, surface, contributionId)
    if (!loaded || isCurrent?.() === false) {
      return null
    }
    return { ...loaded.entry, sessionToken: this.sessions.issue(ownerKey, loaded.binding) }
  }

  private async load(
    pluginKey: string,
    surface: PluginPanelSessionBinding['surface'],
    contributionId: string
  ): Promise<LoadedPluginPanel | null> {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    const contribution = plugin ? findFrameContribution(plugin, surface, contributionId) : null
    if (!plugin || !contribution) {
      return null
    }
    const html = await this.readShell(plugin, contribution.entry, surface)
    if (html === null) {
      return null
    }
    return {
      entry: { html },
      binding: {
        pluginKey,
        surface,
        contributionId,
        rootDir: plugin.rootDir,
        manifestRevision: JSON.stringify(plugin.manifest)
      }
    }
  }

  private async readShell(
    plugin: ValidDiscoveredPlugin,
    entryPath: string,
    surface: PluginFrameSurface
  ): Promise<string | null> {
    const { pluginKey } = plugin
    const log = this.options.log(pluginKey)
    try {
      await this.options.contentVerifier.verify(plugin)
      const html = buildPluginPanelShellHtml(
        await readContainedPluginArtifactText(
          plugin.rootDir,
          entryPath,
          PLUGIN_PANEL_ENTRY_MAX_BYTES
        ),
        surface
      )
      const current = this.options.resolveApprovedPlugin(pluginKey)
      if (current !== plugin || current.rootDir !== plugin.rootDir) {
        return null
      }
      return html
    } catch (error) {
      log(
        `${surface} entry ${entryPath} rejected: ${error instanceof Error ? error.message : String(error)}`
      )
      return null
    }
  }
}

function findFrameContribution(
  plugin: ValidDiscoveredPlugin,
  surface: PluginPanelSessionBinding['surface'],
  id: string
): { entry: string } | null {
  const list =
    surface === 'panel'
      ? plugin.manifest.contributes.panels
      : plugin.manifest.contributes.customEditors
  return list.find((entry) => entry.id === id) ?? null
}
