// src/relay/browser-profile-handlers.ts
// browser.profile* RPC handlers — dev-server-wide browser profile
// operations, distinct from the per-worktree page handlers in
// browser-page-handlers.ts: these are keyed by devServerId, not worktree.
//
// Split out of browser-handler.ts (which is now a re-export barrel) to stay
// under oxlint's max-lines budget. See browser-handler.ts's header comment
// for the session-scoping model this file's fixed default session name
// deliberately stays outside of.

import type { AgentLogger } from './agent-logger'
import {
  makeFailure,
  makeSuccess,
  runBrowserCommand,
  type JsonRpcId,
  type JsonRpcResponse
} from './browser-command-runner'

// ─── browser.profileClearDefaultCookies ─────────────────────────────────────

// Why: this relay is keyed by devServerId, not worktree
// (channels_browser_profiles.go's registerBrowserProfileRelay carries no
// worktree field) — "the default cookies" means the dev-server-wide
// default agent-browser session, not any one worktree's session. Uses a
// fixed session name reserved for this purpose, distinct from any real
// worktree id, so this never collides with (or accidentally clears) an
// active worktree's browser session.
const DEFAULT_BROWSER_PROFILE_SESSION = '__default_browser_profile__'

export async function handleBrowserProfileClearDefaultCookies(
  id: JsonRpcId,
  _params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    await runBrowserCommand(DEFAULT_BROWSER_PROFILE_SESSION, ['cookies', 'clear'])
    return makeSuccess(id, { cleared: true }) // matches BrowserProfileClearDefaultCookiesResult.cleared
    // (frontend/src/shared/runtime-types.ts:883-885)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileClearDefaultCookies failed: ${message}`)
    return makeFailure(id, message)
  }
}

// ─── browser.profileDetectBrowsers ──────────────────────────────────────────

export async function handleBrowserProfileDetectBrowsers(
  id: JsonRpcId,
  _params: Record<string, unknown>,
  log: AgentLogger
): Promise<JsonRpcResponse> {
  try {
    const { detectInstalledBrowsersOnHost } = await import('./browser-profile-detect')
    return makeSuccess(id, { browsers: detectInstalledBrowsersOnHost() }) // matches BrowserDetectProfilesResult.browsers
    // (frontend/src/shared/runtime-types.ts:870-879)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`browser.profileDetectBrowsers failed: ${message}`)
    return makeFailure(id, message)
  }
}
