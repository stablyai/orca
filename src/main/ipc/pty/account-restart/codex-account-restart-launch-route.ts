import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import type { CodexPaneAccountRecord } from '../../../codex/configuration/homes/codex-pane-account-registry-types'

type LaunchRouteSettings = {
  codexManagedAccounts?: readonly { id: string; managedHomePath: string }[]
}

/** The CODEX_HOME main attributed this launch to; null when the record names no home main knows. */
export function attributedCodexHome(
  account: Pick<CodexPaneAccountRecord, 'accountId' | 'homeRoute'>,
  settings: LaunchRouteSettings,
  systemCodexHomePath: string
): string | null {
  if (account.homeRoute === 'real-home') {
    return systemCodexHomePath
  }
  if (account.homeRoute !== 'account-home' || !account.accountId) {
    return null
  }
  return (
    settings.codexManagedAccounts?.find((candidate) => candidate.id === account.accountId)
      ?.managedHomePath ?? null
  )
}

/**
 * Whether the child really ran on the attributed home. Codex writes its transcript under its own
 * CODEX_HOME, so the path it reported is the child's route; a CODEX_HOME a retained terminal
 * service passed down instead of the planned one puts it elsewhere, and the restart stays manual.
 */
export function transcriptIsUnderCodexHome(transcriptPath: string, codexHome: string): boolean {
  const sessions = `${normalizeRuntimePathForComparison(codexHome)}/sessions/`
  return normalizeRuntimePathForComparison(transcriptPath).startsWith(sessions)
}
