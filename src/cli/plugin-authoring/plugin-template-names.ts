// Kept apart from the template bodies so command specs load without them.
export const PLUGIN_TEMPLATE_NAMES = [
  'theme',
  'terminal-theme',
  'icon-theme',
  'syntax',
  'language-pack',
  'editor',
  'panel'
] as const

export type PluginTemplateName = (typeof PLUGIN_TEMPLATE_NAMES)[number]

export function isPluginTemplateName(value: string): value is PluginTemplateName {
  return PLUGIN_TEMPLATE_NAMES.some((name) => name === value)
}
