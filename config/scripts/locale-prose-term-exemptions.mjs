const LOCALIZED_PROSE_TERM_KEYS = new Set([
  'auto.components.right.sidebar.ChecksPanel.3c3ad3a1d2',
  'auto.components.right.sidebar.ChecksPanel.495b2f8c4b',
  'auto.components.right.sidebar.ChecksPanel.aa95b81a3a',
  'auto.components.right.sidebar.ChecksPanel.ed3f79c031',
  'auto.components.right.sidebar.ChecksPanel.f273f2271c',
  'auto.components.sidebar.AddRemoteHostDialog.sshPersistenceDefault',
  'auto.components.settings.RepositoryIconPicker.emojiTooLongForRepoIcon',
  'auto.hooks.useMacosTccPromptNotice.description',
  'auto.components.settings.DeveloperPermissionsPane.7ca17b62c8'
])

const LOCALIZABLE_PROSE_TERMS = new Set([
  'Agent',
  'Agents',
  'agent',
  'agents',
  'Repo',
  'Repos',
  'repo',
  'repos',
  'Terminal',
  'Terminals',
  'terminal',
  'terminals'
])

export function isLocalizedProseTermContext(term, key) {
  return LOCALIZED_PROSE_TERM_KEYS.has(key) && LOCALIZABLE_PROSE_TERMS.has(term)
}
