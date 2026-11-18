import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { parseHooksJsonText } from '../agent-hooks/installation/configuration/hooks-json-read'
import { CLAUDE_AGENT_VIEW_COMMAND } from '../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

// Only Orca's writer copies these into a config: its hook-script folder and its Claude keybinding.
const ORCA_REFERENCES: readonly RegExp[] = [
  /\.orca[\\/]+agent-hooks[\\/]/u,
  new RegExp(`command:${CLAUDE_AGENT_VIEW_COMMAND}\\b`, 'u')
]

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

function sameConfig(backup: string, current: string | null): boolean {
  if (current === null) {
    return false
  }
  if (backup === current) {
    return true
  }
  const [a, b] = [parseHooksJsonText(backup), parseHooksJsonText(current)]
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The rolling `<config>.bak` Orca's writer keeps, when it is Orca's to delete: it still names
 * Orca's hook scripts or keybinding, or it repeats the current config so nothing is lost.
 * Anything else may be the user's only copy of an earlier config, so it stays.
 */
export async function findOrcaConfigBackup(configPath: string): Promise<string | null> {
  // The writer resolves a symlinked config and keeps its backup beside the target.
  const link = await lstat(configPath).catch(() => null)
  const writePath = link?.isSymbolicLink()
    ? await realpath(configPath).catch(() => configPath)
    : configPath
  const backupPath = `${writePath}.bak`
  const stat = await lstat(backupPath).catch(() => null)
  if (!stat?.isFile()) {
    return null
  }
  const backup = await readText(backupPath)
  if (backup === null) {
    return null
  }
  const orcaOwned =
    ORCA_REFERENCES.some((pattern) => pattern.test(backup)) ||
    sameConfig(backup, await readText(writePath))
  return orcaOwned ? backupPath : null
}

export async function removeOrcaConfigBackups(configPaths: readonly string[]): Promise<void> {
  for (const configPath of new Set(configPaths)) {
    const backupPath = await findOrcaConfigBackup(configPath)
    if (backupPath) {
      await rm(backupPath, { force: true })
    }
  }
}
