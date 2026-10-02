import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { codexCommandLineJoinsSharedServer } from '../../shared/codex-shared-server-command'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex,
  type ProcessIdentityRow
} from '../../shared/process-table-index'
import { getProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { isShellStartupEnvProbeSupported } from '../pty/shell-startup-env'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from './codex-home-paths'
import { getCodexPaneAccount } from './codex-pane-account-registry'
import { probeCodexSharedServer } from './codex-shared-server-probe'

type CommandRow = ProcessIdentityRow & { command: string }

/**
 * The outermost Codex under the pane's shell. Outermost because a launcher
 * (`node …/codex.js`) carries the argv, and on Windows the shared server it
 * starts is its own child.
 */
export function findPaneCodexCommandLine(
  rows: readonly CommandRow[],
  rootPid: number
): string | null {
  let outermost: (CommandRow & { depth: number }) | null = null
  for (const row of collectDescendantsFromIndex(getProcessTableIndex(rows), rootPid)) {
    if (
      (!outermost || row.depth < outermost.depth) &&
      recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })?.agent ===
        'codex'
    ) {
      outermost = row
    }
  }
  return outermost?.command ?? null
}

/**
 * The CODEX_HOME this host pane launched with, or null when it cannot be named.
 * A CODEX_HOME the user exports later in the pane's shell is not seen.
 */
export function resolveCodexPaneHome(ptyId: string): string | null {
  const record = getCodexPaneAccount(ptyId)
  if (record?.selectionKey !== 'host') {
    return null
  }
  const customHome =
    record.environmentHomeOverride?.codexHome ?? record.shellStartupHomeOverride?.codexHome
  switch (record.homeRoute) {
    case 'real-home':
      return customHome ?? getSystemCodexHomePath()
    case 'custom-home':
      return customHome ?? null
    case 'shared-home':
      // Why: off Windows the mirror is retired and never promoted, so a fix there would be reverted.
      return isShellStartupEnvProbeSupported() ? null : resolveOrcaManagedCodexHomePath()
    // Why: an unnamed home (managed account, WSL, pre-route record) skips the warning rather than probing the wrong server.
    case 'account-home':
    case 'wsl-home':
    case undefined:
      return null
  }
}

/** Whether the pane's home is Orca's mirror, whose settings reach ~/.codex only through promotion. */
export function isCodexPaneOnOrcaMirrorHome(ptyId: string): boolean {
  return (
    getCodexPaneAccount(ptyId)?.homeRoute === 'shared-home' && resolveCodexPaneHome(ptyId) !== null
  )
}

/** Whether the Codex running in this local pane is a client of Codex's shared server. */
export async function isPaneCodexOnSharedServer(ptyId: string, rootPid: number): Promise<boolean> {
  const codexHome = resolveCodexPaneHome(ptyId)
  if (!codexHome) {
    return false
  }
  const rows: readonly CommandRow[] =
    process.platform === 'win32' ? await readWindowsProcessTable() : await getProcessTableSnapshot()
  const commandLine = findPaneCodexCommandLine(rows, rootPid)
  return (
    commandLine !== null &&
    codexCommandLineJoinsSharedServer(commandLine) &&
    (await probeCodexSharedServer(codexHome)) === 'live'
  )
}
