import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

// Daemon PTYs outlive the app, so a launch's account must survive a restart too.
let cached: Record<string, string> | null = null

function registryPath(): string {
  return join(getAppEnvironment().getPath('userData'), 'claude-pane-accounts.json')
}

/** PTYs launched on a chosen Claude account (`--account`), by PTY id; `system` is System default. */
export function getClaudePaneAccounts(): Readonly<Record<string, string>> {
  if (!cached) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(registryPath(), 'utf8'))
      cached =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.fromEntries(
              Object.entries(parsed).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string'
              )
            )
          : {}
    } catch {
      // shortcut: an unreadable file forgets every pin, so a switch may move those panes; persist per PTY if that bites.
      cached = {}
    }
  }
  return cached
}

/** Null forgets the PTY: it follows the selection like any other terminal. */
export function recordClaudePaneAccount(ptyId: string, accountId: string | null): void {
  const current = getClaudePaneAccounts()
  if ((current[ptyId] ?? null) === accountId) {
    return
  }
  const next = { ...current }
  if (accountId === null) {
    delete next[ptyId]
  } else {
    next[ptyId] = accountId
  }
  cached = next
  try {
    writeFileAtomically(registryPath(), JSON.stringify(next), { mode: 0o600 })
  } catch (error) {
    console.warn('[claude-accounts] Could not save the account of a pinned terminal:', error)
  }
}
