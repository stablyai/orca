import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime-client'
import { CORE_HANDLERS } from './handlers/core'
import { REPO_HANDLERS } from './handlers/repo'
import { WORKTREE_HANDLERS } from './handlers/worktree'
import { TERMINAL_HANDLERS } from './handlers/terminal'
import { BROWSER_NAV_HANDLERS } from './handlers/browser-nav'
import { BROWSER_INTERACT_HANDLERS } from './handlers/browser-interact'
import { BROWSER_TAB_HANDLERS } from './handlers/browser-tab'
import { BROWSER_PROFILE_HANDLERS } from './handlers/browser-profile'
import { BROWSER_COOKIE_HANDLERS } from './handlers/browser-cookie'
import { BROWSER_CAPTURE_HANDLERS } from './handlers/browser-capture'
import { BROWSER_ENV_HANDLERS } from './handlers/browser-env'
import { BROWSER_STORAGE_HANDLERS } from './handlers/browser-storage'
import { ORCHESTRATION_HANDLERS } from './handlers/orchestration'
import { COMPUTER_HANDLERS } from './handlers/computer'
import { NOTE_HANDLERS } from './handlers/note'

export type HandlerContext = {
  flags: Map<string, string | boolean>
  client: RuntimeClient
  cwd: string
  json: boolean
}

export type CommandHandler = (ctx: HandlerContext) => Promise<void>

function buildHandlers(): Map<string, CommandHandler> {
  const table = new Map<string, CommandHandler>()
  const groups = [
    CORE_HANDLERS,
    REPO_HANDLERS,
    WORKTREE_HANDLERS,
    TERMINAL_HANDLERS,
    BROWSER_NAV_HANDLERS,
    BROWSER_INTERACT_HANDLERS,
    BROWSER_TAB_HANDLERS,
    BROWSER_PROFILE_HANDLERS,
    BROWSER_COOKIE_HANDLERS,
    BROWSER_CAPTURE_HANDLERS,
    BROWSER_ENV_HANDLERS,
    BROWSER_STORAGE_HANDLERS,
    ORCHESTRATION_HANDLERS,
    COMPUTER_HANDLERS,
    NOTE_HANDLERS
  ]
  for (const group of groups) {
    for (const [key, handler] of Object.entries(group)) {
      if (table.has(key)) {
        throw new Error(`Duplicate CLI handler registration for "${key}"`)
      }
      table.set(key, handler)
    }
  }
  return table
}

const HANDLERS = buildHandlers()

export async function dispatch(commandPath: string[], ctx: HandlerContext): Promise<void> {
  const handler = HANDLERS.get(commandPath.join(' '))
  if (!handler) {
    throw new RuntimeClientError('invalid_argument', `Unknown command: ${commandPath.join(' ')}`)
  }
  await handler(ctx)
}
