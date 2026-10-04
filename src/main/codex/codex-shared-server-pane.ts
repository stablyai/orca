import { win32 as pathWin32 } from 'node:path'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { codexCommandLineJoinsSharedServer } from '../../shared/codex-shared-server-command'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex,
  type ProcessIdentityRow
} from '../../shared/process-table-index'
import { getProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { fishArgsSkipConfig } from '../fish-xdg-data-dirs-handoff'
import { getSystemCodexHomePath } from './codex-home-paths'
import { getCodexPaneAccount } from './codex-pane-account-registry'
import { probeCodexSharedServer } from './codex-shared-server-probe'

type CommandRow = ProcessIdentityRow & { command: string; name?: string }

export type PaneCodexProcess = {
  command: string
  /** Lowercase name of the process that launched Codex, e.g. `zsh` or `pwsh`; null when absent. */
  shell: string | null
}

// Why name first: Windows rows carry the image name, and their command line may be empty.
function executableName(row: CommandRow): string {
  const executable = row.name || row.command.trim().split(/\s+/)[0] || ''
  return pathWin32
    .basename(executable)
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/**
 * The outermost Codex under the pane's shell, and the shell it was typed into.
 * Outermost because a launcher (`node …/codex.js`) carries the argv, and on
 * Windows the shared server it starts is its own child.
 */
export function findPaneCodex(
  rows: readonly CommandRow[],
  rootPid: number
): PaneCodexProcess | null {
  const index = getProcessTableIndex(rows)
  let outermost: (CommandRow & { depth: number }) | null = null
  for (const row of collectDescendantsFromIndex(index, rootPid)) {
    if (
      (!outermost || row.depth < outermost.depth) &&
      recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true })?.agent ===
        'codex'
    ) {
      outermost = row
    }
  }
  if (!outermost) {
    return null
  }
  const parent = index.byPid.get(outermost.ppid)
  const shell = parent ? executableName(parent) : null
  // Why: fish without config never loads Orca's codex function, so it counts as unwrapped.
  const unwrappedFish =
    shell === 'fish' && fishArgsSkipConfig(parent?.command.trim().split(/\s+/).slice(1) ?? [])
  return { command: outermost.command, shell: unwrappedFish ? null : shell }
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
    // Why: an unnamed home (managed account, WSL, pre-route record) skips the
    // warning rather than probing the wrong server. Orca's mirror (shared-home)
    // gets none either, as macOS and Linux already did: it is a fallback lane
    // (custom CODEX_HOME, hook approval) or a pre-upgrade home refreshed from ~/.codex.
    case 'shared-home':
    case 'account-home':
    case 'wsl-home':
    case undefined:
      return null
  }
}

/** This local pane's Codex when it is a client of Codex's shared server; otherwise null. */
export async function findPaneCodexOnSharedServer(
  ptyId: string,
  rootPid: number
): Promise<PaneCodexProcess | null> {
  const codexHome = resolveCodexPaneHome(ptyId)
  if (!codexHome) {
    return null
  }
  const rows: readonly CommandRow[] =
    process.platform === 'win32' ? await readWindowsProcessTable() : await getProcessTableSnapshot()
  const codex = findPaneCodex(rows, rootPid)
  return codex &&
    codexCommandLineJoinsSharedServer(codex.command) &&
    (await probeCodexSharedServer(codexHome)) === 'live'
    ? codex
    : null
}
