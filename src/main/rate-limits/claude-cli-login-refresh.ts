import { isAbsolute } from 'node:path'
import { buildConfiguredProxyEnv, type NetworkProxySettings } from '../../shared/network-proxy'
import { isRunnableCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { applyClaudeEnvPatch } from '../claude-accounts/environment'
import {
  isClaudeAuthSwitchInProgress,
  whenClaudeAuthSwitchSettles
} from '../claude-accounts/live-pty-gate'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { withoutInheritedClaudeConfigDir } from '../claude/claude-config-dir-pin'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from '../claude/claude-stream-json-connection'
import { resolveClaudeCommand } from '../codex-cli/command'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const USAGE_REQUEST_TIMEOUT_MS = 20_000

export type ClaudeCliLoginRefreshOutcome =
  | { kind: 'answered' }
  /** The installed CLI has no `get_usage`; retrying the same binary cannot change that. */
  | { kind: 'unsupported'; message: string }
  /** Claude started but never answered (it exited, timed out, or was stopped). */
  | { kind: 'failed'; message: string }
  /** Orca never started Claude, so the stored login cannot have changed because of it. */
  | { kind: 'not-started'; message: string }
  /** No runnable Claude binary was found (missing or not executable), so nothing was started. */
  | { kind: 'not-launched'; message: string }

type ConnectClaude = typeof openClaudeStreamJsonConnection

function isUnsupportedSubtype(message: string): boolean {
  return /unsupported control request|no control request/i.test(message)
}

/**
 * Asks the account's own Claude CLI for plan usage so it refreshes its login under its own
 * refresh lock and saves it to its own store. The answer itself is discarded: the CLI may serve
 * a cached reading and reports transport failures as an empty one, so the caller re-reads the
 * stored credentials and asks the usage endpoint itself.
 */
export async function refreshClaudeLoginViaCli(input: {
  authPreparation: ClaudeRuntimeAuthPreparation
  readCurrentAuthProvenance: () => string
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
  connect?: ConnectClaude
  resolveCommand?: () => string
}): Promise<ClaudeCliLoginRefreshOutcome> {
  if (input.signal?.aborted) {
    return { kind: 'not-started', message: 'aborted' }
  }
  // A switch re-materializes the runtime credentials this child would refresh.
  if (!(await whenClaudeAuthSwitchSettles())) {
    return { kind: 'not-started', message: 'a Claude account switch is in progress' }
  }
  if (input.signal?.aborted) {
    return { kind: 'not-started', message: 'aborted' }
  }
  // Every login shares the runtime home, so after a switch the child would refresh whichever
  // account is now selected, possibly the user's own system login.
  if (
    isClaudeAuthSwitchInProgress() ||
    input.readCurrentAuthProvenance() !== input.authPreparation.provenance
  ) {
    return { kind: 'not-started', message: 'the selected Claude account changed' }
  }
  const command = (input.resolveCommand ?? resolveClaudeCommand)()
  // Why: on POSIX the spawn goes through a supervisor that always starts, so a missing binary
  // only shows up as the supervisor's exit; check before launching instead. The resolver
  // returns the bare name when it found no runnable file.
  if (!isAbsolute(command) || !isRunnableCommand(process.platform, command)) {
    return { kind: 'not-launched', message: `no runnable Claude CLI at ${command}` }
  }
  const launch: ClaudeStreamJsonLaunch = {
    pathToClaudeCodeExecutable: command,
    // No user message is ever sent, so nothing reaches the model; these keep the session-less
    // child from running hooks, MCP servers or project settings, or saving a transcript.
    options: {
      settingSources: ['user'],
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: {},
      settings: { disableAllHooks: true }
    },
    // Untrusted folders are trusted in headless mode, so the child gets an empty Orca-owned one.
    cwd: resolveHiddenRateLimitPtyCwd(),
    env: withCliRuntimeOnPath(command, {
      ...applyClaudeEnvPatch(
        withoutInheritedClaudeConfigDir(process.env),
        input.authPreparation.envPatch,
        { stripAuthEnv: input.authPreparation.stripAuthEnv }
      ),
      // The CLI spawned directly would otherwise reach Anthropic outside the user's proxy.
      ...buildConfiguredProxyEnv(input.networkProxySettings),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false'
    })
  }

  const fault: { first: Error | null } = { first: null }
  let connection: ClaudeStreamJsonConnection | null = null
  const closeOnAbort = (): void => {
    void connection?.close()
  }
  input.signal?.addEventListener('abort', closeOnAbort, { once: true })
  try {
    connection = await (input.connect ?? openClaudeStreamJsonConnection)(launch, {
      onFault: (error) => {
        fault.first ??= error
      }
    })
  } catch (error) {
    input.signal?.removeEventListener('abort', closeOnAbort)
    // The connection throws only before a child exists.
    return { kind: 'not-started', message: error instanceof Error ? error.message : String(error) }
  }
  try {
    if (input.signal?.aborted) {
      return { kind: 'failed', message: 'aborted' }
    }
    await connection.getUsage({ timeoutMs: USAGE_REQUEST_TIMEOUT_MS })
    return { kind: 'answered' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isUnsupportedSubtype(message)) {
      return { kind: 'unsupported', message }
    }
    // An exit before the reply (e.g. unaccepted terms) closes the query; the stderr tail is the reason.
    return { kind: 'failed', message: fault.first?.message ?? message }
  } finally {
    input.signal?.removeEventListener('abort', closeOnAbort)
    await connection?.close()
  }
}
