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
  /** Lowercase parent process name, or null if absent or unwrapped fish. */
  shell: string | null
}

// Windows rows may have an image name but no command line.
function executableName(row: CommandRow): string {
  const executable = row.name || row.command.trim().split(/\s+/)[0] || ''
  return pathWin32
    .basename(executable)
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/** The outermost launcher carries the argv; its children may include a shared server. */
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
  // Fish without config never loads Orca's Codex wrapper.
  const unwrappedFish =
    shell === 'fish' && fishArgsSkipConfig(parent?.command.trim().split(/\s+/).slice(1) ?? [])
  return { command: outermost.command, shell: unwrappedFish ? null : shell }
}

/** Launch-time home only; later shell exports are not observed. */
export function resolveCodexPaneHome(ptyId: string): string | null {
  const record = getCodexPaneAccount(ptyId)
  if (record?.selectionKey !== 'host') {
    return null
  }
  switch (record.homeRoute) {
    // Custom CODEX_HOME uses the mirror; real-home always means the system home.
    case 'real-home':
      return getSystemCodexHomePath()
    // Only probe real-home panes; fallback or untracked homes could target the wrong server.
    case 'shared-home':
    case 'account-home':
    case 'wsl-home':
    case undefined:
      return null
  }
}

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
