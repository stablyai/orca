import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { RuntimeStore } from './runtime-store-contract'

type RestoreHintSource = Pick<
  RuntimeStore,
  'peekOrcadMigrationTerminalRestoreHint' | 'consumeOrcadMigrationTerminalRestoreHint'
>

/** Non-null `connectionId` is an SSH workspace, whose folders this host's filesystem cannot see. */
type RestoreHintWorkspace = { id: string; connectionId?: string | null }

export type MigratedPaneRestoreHint = {
  peekCwd: (requestedCwd: string | null | undefined) => Promise<string | null>
  consume: () => void
  /** A spawn-commit callback that spends the hint first. */
  consumeThen: (onCommitted?: () => void) => () => void
}

/** One create's view of its pane's hint: peeked to pick the cwd, consumed once the pane spawns. */
export function migratedPaneRestoreHint(
  store: RestoreHintSource | null | undefined,
  workspace: RestoreHintWorkspace,
  paneKey: string
): MigratedPaneRestoreHint {
  const consume = (): void => consumeMigratedPaneRestoreHint(store, paneKey)
  return {
    peekCwd: (requestedCwd) => peekMigratedPaneRestoreCwd(store, workspace, paneKey, requestedCwd),
    consume,
    consumeThen: (onCommitted) => () => {
      consume()
      onCommitted?.()
    }
  }
}

/**
 * The folder a moved pane last used, for a default-cwd create. Only peeks: the hint is consumed
 * when the pane spawns (see `consumeMigratedPaneRestoreHint`), so a failed create keeps it.
 */
export async function peekMigratedPaneRestoreCwd(
  store: RestoreHintSource | null | undefined,
  workspace: RestoreHintWorkspace,
  paneKey: string,
  requestedCwd: string | null | undefined,
  directoryUsable: (path: string) => Promise<boolean> = isSearchableDirectory
): Promise<string | null> {
  // Hints are Linux paths for a WSL host; a Windows process never opens one.
  if (requestedCwd?.trim() || workspace.connectionId || process.platform === 'win32') {
    return null
  }
  let cwd: string | null
  try {
    cwd = store?.peekOrcadMigrationTerminalRestoreHint?.(paneKey, workspace.id) ?? null
  } catch (error) {
    // An unreadable hint store must not block opening the terminal.
    console.warn('[terminal-create] restore hint unavailable:', error)
    return null
  }
  if (!cwd) {
    return null
  }
  return (await directoryUsable(cwd)) ? cwd : null
}

/** Once the pane spawned, whatever folder it opened in was its restore; the hint is spent. */
export function consumeMigratedPaneRestoreHint(
  store: RestoreHintSource | null | undefined,
  paneKey: string
): void {
  try {
    store?.consumeOrcadMigrationTerminalRestoreHint?.(paneKey)
  } catch (error) {
    // The terminal already opened; a hint left behind is retried on the next spawn.
    console.warn('[terminal-create] restore hint not consumed:', error)
  }
}

// A shell cannot start in a directory it cannot search, so that counts as gone.
async function isSearchableDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory()) {
      return false
    }
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
