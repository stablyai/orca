// Japanese overrides for English values whose translation depends on the call site.
export const JA_KEY_OVERRIDES = {
  // "on" is the toggle state here, but the preposition in the delete confirmation below.
  'auto.components.github.PRFilterSections.1e9b5244f2': { ja: 'オン' },
  'auto.components.settings.TerminalPane.29154326bb': { ja: 'オン' },
  'auto.components.automations.AutomationsPage.1b586f0e2b': { ja: 'の' },
  // Bare "Open" is the PR state elsewhere; these two are the action, as ko/zh/es render it.
  'auto.components.browser.pane.BrowserPane.756bfc25c9': { ja: '開く' },
  'auto.components.right.sidebar.checks.panel.content.7c1f0a2b11': { ja: '開く' }
}
