export type CodexPaneHomeRoute = 'real-home' | 'shared-home' | 'account-home' | 'wsl-home'

export type CodexPaneAccountRecord = {
  /** Spawn selection lane: host or wsl:<distro>. */
  selectionKey: string
  /** Managed account id, or null for the system-default account. */
  accountId: string | null
  /** Older records lack route provenance. */
  homeRoute?: CodexPaneHomeRoute
}

export type CodexPaneAccountRegistryFile = {
  version: 2
  panes: Record<string, CodexPaneAccountRecord>
  /** Set after record loss until daemon inventory proves no unattributed pane remains. */
  legacyWslAttributionUnknown?: true
}
