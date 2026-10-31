/** Starter plugins for `orca plugin create`. Each one validates as-is and runs no build step. */

import { iconTheme, languagePack, syntax, terminalTheme, theme } from './plugin-content-templates'
import { editor, panel } from './plugin-frame-templates'
import type { PluginTemplate, PluginTemplateInput } from './plugin-template-files'
import type { PluginTemplateName } from './plugin-template-names'

const TEMPLATES: Record<PluginTemplateName, (input: PluginTemplateInput) => PluginTemplate> = {
  theme,
  'terminal-theme': terminalTheme,
  'icon-theme': iconTheme,
  syntax,
  'language-pack': languagePack,
  editor,
  panel
}

export function renderPluginTemplate(
  name: PluginTemplateName,
  input: PluginTemplateInput
): PluginTemplate {
  return TEMPLATES[name](input)
}
