export type CodexPaneHomeRoute =
  | 'real-home'
  | 'shared-home'
  | 'account-home'
  | 'wsl-home'
  | 'external-profile-home'

export type CodexPaneAccountRecord = {
  profileBound?: true
  /** 'host' or 'wsl:<distro>' — the selection lane this pane launched from. */
  selectionKey: string
  /** Managed account id, or null for the system-default account. */
  accountId: string | null
  /** Absent only on records written before route provenance was introduced. */
  homeRoute?: CodexPaneHomeRoute
}

export type CodexPaneAccountRegistryFile = {
  version: 2
  panes: Record<string, CodexPaneAccountRecord>
  /** Set after record loss until daemon inventory proves no unattributed pane remains. */
  legacyWslAttributionUnknown?: true
}
