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
import type { PluginHostCaller } from '../plugin-service-host-call'
import { getPluginHostMethodSpec } from '../../../shared/plugins/workers/plugin-host-api'
import type { PluginContentVerifier } from '../plugin-content-integrity'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  readContainedPluginArtifactText
} from '../plugin-artifact-validation'
import {
  PluginPanelSessions,
  type PluginPanelSessionBinding,
  type ResolvedPluginPanelSession
} from './plugin-panel-sessions'
import type { PluginPanelCaller } from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'

type PluginPanelControllerOptions = {
  resolveApprovedPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  contentVerifier: Pick<PluginContentVerifier, 'verify'>
  executeHostCall: (
    pluginKey: string,
    method: string,
    params: unknown,
    surface: PluginSurface,
    caller?: PluginHostCaller
  ) => Promise<PluginHostCallOutcome>
  log: (pluginKey: string) => (line: string) => void
  panelAdmission?: PluginPanelCallAdmission
  /** A session's public id once it can no longer be used (its panel's requests stop). */
  onSessionClosed?: (panelId: string) => void
}

type FrameOpenOptions = { shell?: boolean }

type LoadedPluginPanel = {
  entry: { html: string; ui?: 'components' }
  binding: PluginPanelSessionBinding
}

export class PluginPanelController {
  private readonly sessions: PluginPanelSessions
  private readonly boundOwnerSignals = new WeakSet<AbortSignal>()
  private readonly panelAdmission: PluginPanelCallAdmission

  constructor(private readonly options: PluginPanelControllerOptions) {
    this.panelAdmission = options.panelAdmission ?? createPluginPanelCallAdmission()
    this.sessions = new PluginPanelSessions((panelId) => options.onSessionClosed?.(panelId))
  }

  /** The live, still-approved panel behind an owner's session: what its push channel serves. */
  sessionCaller(
    ownerKey: string,
    sessionToken: string
  ): { pluginKey: string; caller: PluginPanelCaller } | null {
    const binding = this.sessions.resolve(ownerKey, sessionToken)
    return binding && this.isCurrent(binding)
      ? { pluginKey: binding.pluginKey, caller: panelCaller(binding) }
      : null
  }

  async readEntry(pluginKey: string, panelId: string): Promise<{ html: string } | null> {
    return (await this.load(pluginKey, 'panel', panelId))?.entry ?? null
  }

  /** `shell: false` (desktop guests): the guest loads its own document, so no srcdoc HTML is
   *  read, verified or sent; the protocol verifies the tree when the guest navigates. */
  open(
    ownerKey: string,
    pluginKey: string,
    panelId: string,
    isCurrent?: () => boolean,
    options: FrameOpenOptions = {}
  ): Promise<PluginFrameEntry | null> {
    return this.openFrame(ownerKey, pluginKey, 'panel', panelId, isCurrent, options)
  }

  openCustomEditor(
    ownerKey: string,
    pluginKey: string,
    editorId: string,
    isCurrent?: () => boolean,
    options: FrameOpenOptions = {}
  ): Promise<PluginFrameEntry | null> {
    return this.openFrame(ownerKey, pluginKey, 'editor', editorId, isCurrent, options)
  }

  /** The plugin behind this owner's live components-panel session, for its persisted state. */
  componentsPanelPlugin(ownerKey: string, sessionToken: string): string | null {
    return this.componentsPanelBinding(ownerKey, sessionToken)?.pluginKey ?? null
  }

  /** That plugin's root folder, for the image files its panel draws. */
  componentsPanelRoot(ownerKey: string, sessionToken: string): string | null {
    return this.componentsPanelBinding(ownerKey, sessionToken)?.rootDir ?? null
  }

  private componentsPanelBinding(
    ownerKey: string,
    sessionToken: string
  ): { pluginKey: string; rootDir: string } | null {
    const binding = this.sessions.resolve(ownerKey, sessionToken)
    if (!binding || binding.surface !== 'panel') {
      return null
    }
    const plugin = this.options.resolveApprovedPlugin(binding.pluginKey)
    const panel = plugin ? findFrameContribution(plugin, 'panel', binding.contributionId) : null
    return plugin && plugin.rootDir === binding.rootDir && panel?.ui === 'components'
      ? { pluginKey: binding.pluginKey, rootDir: plugin.rootDir }
      : null
  }

  revokeSession(ownerKey: string, sessionToken: string): void {
    this.sessions.revoke(ownerKey, sessionToken)
  }

  /**
   * `desktop`: the call came from this machine's own window over IPC, never from a paired client;
   * `callerWebContentsId` is that window, so its dialogs and budgets bind there.
   */
  async execute(
    ownerKey: string,
    call: unknown,
    origin: { desktop?: boolean; callerWebContentsId?: number } = {}
  ): Promise<PluginHostCallOutcome> {
    const sessionToken = this.extractSessionToken(call)
    if (!sessionToken) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    const binding = this.sessions.resolve(ownerKey, sessionToken)
    if (!binding) {
      return { ok: false, code: 'invalid_request', error: 'invalid panel session' }
    }
    // Why: a dialog or browser tab on this machine must never answer a remote client's click.
    // Their own lane: a save carries a whole file, far past the 64 KiB message budget.
    const userMethod = getPluginHostMethodSpec(this.readAction(call))?.userActivation === true
    if (userMethod && !origin.desktop) {
      return {
        ok: false,
        code: 'not_permitted',
        error: 'this method is only available in the Orca desktop app'
      }
    }
    const admissionRefusal = userMethod
      ? null
      : admitPluginPanelCall(this.panelAdmission, binding.pluginKey, call)
    if (admissionRefusal) {
      return admissionRefusal
    }
    const parsed = panelActionCallSchema.safeParse(call)
    if (!parsed.success) {
      return { ok: false, code: 'invalid_request', error: 'malformed panel action call' }
    }
    if (!this.isCurrent(binding)) {
      return { ok: false, code: 'unavailable', error: 'panel session is no longer available' }
    }
    return this.options.executeHostCall(
      binding.pluginKey,
      parsed.data.action,
      parsed.data.params,
      binding.surface,
      {
        ...(origin.desktop ? { webContentsId: origin.callerWebContentsId } : {}),
        panel: panelCaller(binding)
      }
    )
  }

  private isCurrent(binding: PluginPanelSessionBinding): boolean {
    const plugin = this.options.resolveApprovedPlugin(binding.pluginKey)
    return (
      plugin !== null &&
      plugin.rootDir === binding.rootDir &&
      JSON.stringify(plugin.manifest) === binding.manifestRevision &&
      findFrameContribution(plugin, binding.surface, binding.contributionId) !== null
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

  private readAction(call: unknown): string {
    try {
      const action =
        typeof call === 'object' && call !== null && 'action' in call ? call.action : null
      return typeof action === 'string' ? action : ''
    } catch {
      return ''
    }
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
    isCurrent: (() => boolean) | undefined,
    options: FrameOpenOptions
  ): Promise<PluginFrameEntry | null> {
    if (isCurrent?.() === false) {
      return null
    }
    const loaded = await this.load(pluginKey, surface, contributionId, options.shell !== false)
    if (!loaded || isCurrent?.() === false) {
      return null
    }
    return { ...loaded.entry, sessionToken: this.sessions.issue(ownerKey, loaded.binding) }
  }

  private async load(
    pluginKey: string,
    surface: PluginPanelSessionBinding['surface'],
    contributionId: string,
    withShell = true
  ): Promise<LoadedPluginPanel | null> {
    const plugin = this.options.resolveApprovedPlugin(pluginKey)
    const contribution = plugin ? findFrameContribution(plugin, surface, contributionId) : null
    if (!plugin || !contribution) {
      return null
    }
    const declarative = contribution.ui === 'components'
    // Why no entry text: a declarative entry is a module the desktop guest imports; browser
    // clients get an empty shell and show that the panel needs the desktop app.
    const html = withShell
      ? await this.readShell(plugin, declarative ? null : contribution.entry, surface)
      : ''
    if (html === null) {
      return null
    }
    return {
      entry: declarative ? { html, ui: 'components' } : { html },
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
    entryPath: string | null,
    surface: PluginFrameSurface
  ): Promise<string | null> {
    const { pluginKey } = plugin
    const log = this.options.log(pluginKey)
    try {
      await this.options.contentVerifier.verify(plugin)
      const html = buildPluginPanelShellHtml(
        entryPath === null
          ? ''
          : await readContainedPluginArtifactText(
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

function panelCaller(binding: ResolvedPluginPanelSession): PluginPanelCaller {
  return { id: binding.publicId, surface: binding.surface, contributionId: binding.contributionId }
}

function findFrameContribution(
  plugin: ValidDiscoveredPlugin,
  surface: PluginPanelSessionBinding['surface'],
  id: string
): { entry: string; ui?: string } | null {
  const list =
    surface === 'panel'
      ? plugin.manifest.contributes.panels
      : plugin.manifest.contributes.customEditors
  return list.find((entry) => entry.id === id) ?? null
}
