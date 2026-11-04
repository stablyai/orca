import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import type { RuntimeStore } from './runtime-store-contract'

type RestoreHintSource = Pick<
  RuntimeStore,
  'peekOrcadMigrationTerminalRestoreHint' | 'consumeOrcadMigrationTerminalRestoreHint'
>

type RestoreHintWorkspace = { id: string; connectionId?: string | null }

export type MigratedPaneRestoreHint = {
  peekCwd: (requestedCwd: string | null | undefined) => Promise<string | null>
  consume: () => void
  consumeThen: (onCommitted?: () => void) => () => void
}

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

/** Peek until spawn commits; failed creates retain their last-cwd hint. */
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
    console.warn('[terminal-create] restore hint unavailable:', error)
    return null
  }
  if (!cwd) {
    return null
  }
  return (await directoryUsable(cwd)) ? cwd : null
}

export function consumeMigratedPaneRestoreHint(
  store: RestoreHintSource | null | undefined,
  paneKey: string
): void {
  try {
    store?.consumeOrcadMigrationTerminalRestoreHint?.(paneKey)
  } catch (error) {
    console.warn('[terminal-create] restore hint not consumed:', error)
  }
}

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
