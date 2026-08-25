import type {
  CodexEnvironmentHomeOverride,
  CodexShellStartupHomeOverride
} from './codex-real-home-path'

export type CodexPaneHomeRoute =
  | 'real-home'
  | 'shared-home'
  | 'account-home'
  | 'custom-home'
  | 'wsl-home'

export type CodexPaneAccountRecord = {
  /** 'host' or 'wsl:<distro>' — the selection lane this pane launched from. */
  selectionKey: string
  /** Managed account id, or null for the system-default account. */
  accountId: string | null
  /** Absent only on records written before route provenance was introduced. */
  homeRoute?: CodexPaneHomeRoute
  /** Rechecked when CODEX_HOME came from process-global shell startup. */
  shellStartupHomeOverride?: CodexShellStartupHomeOverride
  /** Rechecked after restart when CODEX_HOME came from the process environment. */
  environmentHomeOverride?: CodexEnvironmentHomeOverride
}

export type CodexPaneAccountRegistryFile = {
  version: 2
  panes: Record<string, CodexPaneAccountRecord>
}
