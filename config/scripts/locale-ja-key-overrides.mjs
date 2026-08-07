// Japanese key-specific overrides, for English values whose Japanese depends on the call site.
// Kept out of locale-ja-value-overrides.mjs because a value override matches every use of the
// same English string, and out of locale-key-overrides.mjs to keep that file under max-lines.
export const JA_KEY_OVERRIDES = {
  // Why: "on" is the toggle state in these two, but the preposition in the external-automation
  // delete confirmation, where オン renders as "外部ソース オン myhost".
  'auto.components.github.PRFilterSections.1e9b5244f2': { ja: 'オン' },
  'auto.components.settings.TerminalPane.29154326bb': { ja: 'オン' },
  'auto.components.automations.AutomationsPage.1b586f0e2b': { ja: 'の' },
  // Why: bare "Open" is the PR/issue state almost everywhere, so it cannot be a value override.
  // These two are the action, as ko/zh/es already render them (열기 / 打开 / Abrir).
  'auto.components.browser.pane.BrowserPane.756bfc25c9': { ja: '開く' },
  'auto.components.right.sidebar.checks.panel.content.7c1f0a2b11': { ja: '開く' }
}
