const LOCALIZED_PROSE_TERM_KEYS = new Set([
  'auto.hooks.useMacosTccPromptNotice.description',
  'auto.components.settings.DeveloperPermissionsPane.7ca17b62c8'
])

const LOCALIZABLE_PROSE_TERMS = new Set([
  'Agent',
  'Agents',
  'agent',
  'agents',
  'Terminal',
  'Terminals',
  'terminal',
  'terminals'
])

export function isLocalizedProseTermContext(term, key) {
  return LOCALIZED_PROSE_TERM_KEYS.has(key) && LOCALIZABLE_PROSE_TERMS.has(term)
}
