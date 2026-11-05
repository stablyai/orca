import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/** Avoid rewriting an unchanged pointer on every launch. */
export function writeClaudePointerFile(path: string, home: string): void {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== home) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileAtomically(path, home, { mode: 0o600 })
  }
}

export type ClaudeProjectPinRouter = {
  accountHome(accountId: string): string
  coveredBySystemDefault(accountId: string): boolean
}

/** A pinned account's folder, or null when it runs on System default's matching login. */
export function claudeProjectAccountHome(
  router: ClaudeProjectPinRouter,
  accountId: string
): string | null {
  return router.coveredBySystemDefault(accountId) ? null : router.accountHome(accountId)
}

/** Each pinned account keeps its own pointer beside its folder, so its panes ignore the selection
 *  and the pointer goes away with the account. */
export function claudeProjectPointerPath(
  router: ClaudeProjectPinRouter,
  accountId: string
): string {
  return join(dirname(router.accountHome(accountId)), 'project-pointer')
}

export function writeClaudeProjectPointer(
  router: ClaudeProjectPinRouter,
  accountId: string
): string {
  const pointer = claudeProjectPointerPath(router, accountId)
  writeClaudePointerFile(pointer, claudeProjectAccountHome(router, accountId) ?? '')
  return pointer
}

/** A pin that cannot be written falls back to the selection rather than block a terminal. */
export function pinnedClaudePointer(
  router: ClaudeProjectPinRouter,
  accountId: string | null,
  selectionPointer: string
): { accountId: string | null; pointer: string } {
  if (!accountId) {
    return { accountId: null, pointer: selectionPointer }
  }
  try {
    return { accountId, pointer: writeClaudeProjectPointer(router, accountId) }
  } catch (error) {
    console.warn('[claude-profile] Could not pin the project account:', error)
    return { accountId: null, pointer: selectionPointer }
  }
}

/** The folder a launch runs under: the pinned account's, else the selection's route. */
export function claudeLaunchHome(
  router: ClaudeProjectPinRouter & { routedHome(): string | null },
  projectAccountId?: string | null
): string | null {
  return projectAccountId ? claudeProjectAccountHome(router, projectAccountId) : router.routedHome()
}
