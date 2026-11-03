/** Starter plugins for `orca plugin create`. Each one validates as-is and runs no build step. */

import { iconTheme, languagePack, syntax, terminalTheme, theme } from './plugin-content-templates'
import { panel } from './plugin-frame-templates'
import { editor } from './plugin-editor-template'
import { components } from './plugin-components-template'
import { workerPanel } from './plugin-worker-panel-template'
import { hook } from './plugin-hook-template'
import { card } from './plugin-card-template'
import type { PluginTemplate, PluginTemplateInput } from './plugin-template-files'
import type { PluginTemplateName } from './plugin-template-names'

const TEMPLATES: Record<PluginTemplateName, (input: PluginTemplateInput) => PluginTemplate> = {
  theme,
  'terminal-theme': terminalTheme,
  'icon-theme': iconTheme,
  syntax,
  'language-pack': languagePack,
  card,
  editor,
  panel,
  components,
  'worker-panel': workerPanel,
  hook
}

export function renderPluginTemplate(
  name: PluginTemplateName,
  input: PluginTemplateInput
): PluginTemplate {
  return TEMPLATES[name](input)
}
