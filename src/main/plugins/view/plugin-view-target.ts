import {
  PluginCliError,
  PluginNotFoundError
} from '../../../shared/plugins/approval/plugin-cli-approval'
import { matchPluginFile } from '../../../shared/plugins/contributions/plugin-file-match'
import type { PluginHostListEntry } from '../../../shared/plugins/plugin-list-entry'
import { pluginFrameContentRevision } from '../plugin-dev-revision'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'

/** What `plugins.open` / `plugins.shot` need of the plugin service; a fake in tests. */
export type PluginViewSource = {
  list(): Promise<PluginHostListEntry[]>
  findValidPlugin(pluginKey: string): ValidDiscoveredPlugin | null
}

export type PluginViewPanelTarget = {
  pluginKey: string
  panelId: string
  title: string
  ui: 'components' | 'html'
  /** The `rev` its guest URL carries now; the drawn panel must come from it. */
  guestRevision: string
}

export type PluginViewEditorTarget = { pluginKey: string; editorId: string; title: string }

function refuse(message: string, nextSteps: string[]): PluginCliError {
  return new PluginCliError('invalid_argument', message, { nextSteps })
}

const LIVE_STATUSES = new Set(['running', 'idle', 'restarting'])

async function liveEntry(
  source: PluginViewSource,
  pluginKey: string
): Promise<{ entry: PluginHostListEntry; plugin: ValidDiscoveredPlugin }> {
  const entry = (await source.list()).find((candidate) => candidate.pluginKey === pluginKey)
  const plugin = source.findValidPlugin(pluginKey)
  if (!entry || !plugin) {
    throw new PluginNotFoundError(pluginKey)
  }
  if (!LIVE_STATUSES.has(entry.status)) {
    const why =
      entry.status === 'pending'
        ? 'is waiting for approval'
        : `is ${entry.status}${entry.error ? `: ${entry.error}` : ''}`
    throw refuse(`${pluginKey} ${why}, so Orca shows none of its panels or editors.`, [
      entry.status === 'pending'
        ? `Approve it first: \`orca plugin enable ${pluginKey}\` prints what it would get.`
        : `\`orca plugin logs ${pluginKey}\` shows why; fix it, then run this again.`
    ])
  }
  return { entry, plugin }
}

export async function resolvePluginViewPanel(
  source: PluginViewSource,
  pluginKey: string,
  panelId: string | undefined
): Promise<PluginViewPanelTarget> {
  const { plugin } = await liveEntry(source, pluginKey)
  const panels = plugin.manifest.contributes.panels
  const panel = panelId === undefined ? panels[0] : panels.find((entry) => entry.id === panelId)
  if (!panel) {
    throw refuse(
      panels.length === 0
        ? `${pluginKey} contributes no panels.`
        : `${pluginKey} has no panel ${panelId}.`,
      panels.length === 0
        ? ['Add one under contributes.panels in orca-plugin.json.']
        : [`Its panels: ${panels.map((entry) => entry.id).join(', ')}.`]
    )
  }
  return {
    pluginKey,
    panelId: panel.id,
    title: panel.title,
    ui: panel.ui === 'components' ? 'components' : 'html',
    guestRevision: pluginFrameContentRevision(plugin)
  }
}

/** The plugin's first custom editor whose file match takes `filePath`. */
export async function resolvePluginViewEditor(
  source: PluginViewSource,
  pluginKey: string,
  filePath: string
): Promise<PluginViewEditorTarget> {
  const { plugin } = await liveEntry(source, pluginKey)
  const editors = plugin.manifest.contributes.customEditors
  const editor = editors.find((entry) => matchPluginFile(filePath, entry) !== null)
  if (!editor) {
    throw refuse(
      editors.length === 0
        ? `${pluginKey} contributes no custom editors.`
        : `No ${pluginKey} editor opens ${filePath}.`,
      editors.length === 0
        ? ['Add one under contributes.customEditors in orca-plugin.json.']
        : editors.map(
            (entry) =>
              `${entry.id} opens ${[...entry.filenames, ...entry.extensions.map((ext) => `*${ext}`)].join(', ')}.`
          )
    )
  }
  return { pluginKey, editorId: editor.id, title: editor.title }
}
