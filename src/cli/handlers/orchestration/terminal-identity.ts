import type { RuntimeClient } from '../../runtime-client'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { getTerminalHandle } from '../../selectors'
import { hasStructuredSessionMarker } from '../../../shared/structured-session-marker'
import {
  injectedSessionAddress,
  readInjectedAgentSessionId
} from '../../../shared/agent-session-caller-env'
import { sessionAddressForHost } from '../../session-caller-flags'

/** undefined delegates caller identity to the injected session; the host resolves /clear addresses. */
export async function resolveOrchestrationTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  flagName: 'from' | 'terminal',
  options: { validateEnvHandle?: boolean } = {}
): Promise<string | undefined> {
  // CLI entry already fences caller flags using the command spec.
  const explicit = getOptionalStringFlag(flags, flagName)
  const sessionId = readInjectedAgentSessionId()
  if (sessionId) {
    return explicit ? sessionAddressForHost(explicit, sessionId) : undefined
  }
  if (explicit) {
    return explicit
  }
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (envHandle && envHandle.length > 0) {
    if (flagName === 'from' && options.validateEnvHandle) {
      // Shells can retain stale handles after remint; validate before embedding them in coordinator preambles.
      const live = await isLiveTerminalHandle(envHandle, client)
      if (!live) {
        const reminted = await resolveOrchestrationPaneTerminalHandle(client)
        if (reminted) {
          return reminted
        }
        throwNoActiveSenderTerminal()
      }
    }
    return envHandle
  }
  // Implicit guesses can select a sibling pane and consume its mail; identity-less sessions must refuse.
  if (hasStructuredSessionMarker()) {
    throw structuredSessionRefusal(flagName)
  }
  if (flagName === 'from') {
    return await resolveImplicitOrchestrationSender(flags, cwd, client)
  }
  return await getTerminalHandle(flags, cwd, client)
}

// terminal.show requires a PTY; resolveIdentity also recognizes structured workers without panes.
async function isLiveTerminalHandle(handle: string, client: RuntimeClient): Promise<boolean> {
  try {
    const response = await client.call<{ identity?: { live?: boolean } }>(
      'terminal.resolveIdentity',
      { terminal: handle }
    )
    const live = response.result?.identity?.live
    // An unrecognised shape is an older host answering something else, not a dead handle.
    return typeof live === 'boolean' ? live : await showResolvesTerminalHandle(handle, client)
  } catch (err) {
    if (isStaleTerminalIdentityError(err)) {
      return false
    }
    if (getClientErrorCode(err) === 'method_not_found') {
      // Hosts without the identity probe also predate structured workers, so terminal.show is sufficient.
      return await showResolvesTerminalHandle(handle, client)
    }
    throw err
  }
}

async function showResolvesTerminalHandle(handle: string, client: RuntimeClient): Promise<boolean> {
  try {
    await client.call('terminal.show', { terminal: handle })
    return true
  } catch (err) {
    if (isStaleTerminalIdentityError(err)) {
      return false
    }
    throw err
  }
}

function getClientErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function isStaleTerminalIdentityError(err: unknown): boolean {
  const code = getClientErrorCode(err)
  return code === 'terminal_handle_stale' || code === 'terminal_gone'
}

function isNoActiveTerminalError(err: unknown): boolean {
  return getClientErrorCode(err) === 'no_active_terminal'
}

async function resolveOrchestrationPaneTerminalHandle(
  client: RuntimeClient,
  options: { optional?: boolean } = {}
): Promise<string | undefined> {
  const paneKey = process.env.ORCA_PANE_KEY
  if (!paneKey || paneKey.length === 0) {
    return undefined
  }
  try {
    // Remint by pane key; focus-based fallback can select another caller.
    const response = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
      paneKey
    })
    return response.result.terminal.handle
  } catch (err) {
    if (
      isPaneRemintUnavailableError(err) ||
      (options.optional === true && isOptionalPaneRemintUnavailableError(err))
    ) {
      return undefined
    }
    throw err
  }
}

function isPaneRemintUnavailableError(err: unknown): boolean {
  const code = getClientErrorCode(err)
  const message = getClientErrorMessage(err)
  return (
    code === 'terminal_not_found' ||
    code === 'terminal_handle_stale' ||
    code === 'terminal_gone' ||
    message === 'terminal_not_found' ||
    message === 'terminal_handle_stale' ||
    message === 'terminal_gone'
  )
}

function isOptionalPaneRemintUnavailableError(err: unknown): boolean {
  return getClientErrorCode(err) === 'runtime_unavailable'
}

function getClientErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) {
    return err.message
  }
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' ? message : undefined
}

export function orchestrationCallerLabel(handle: string | undefined): string {
  return handle ?? injectedSessionAddress() ?? 'unknown'
}

/** Named-run reads need no terminal lookup, but the host must still verify declared session lineage. */
export function runScopedSessionCaller(flags: Map<string, string | boolean>): string | undefined {
  const declared = getOptionalStringFlag(flags, 'from')
  const sessionId = readInjectedAgentSessionId()
  return declared && sessionId ? sessionAddressForHost(declared, sessionId) : undefined
}

export async function resolveCoordinatorTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  return await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from', {
    validateEnvHandle: true
  })
}

async function resolveImplicitOrchestrationSender(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  try {
    // An arbitrary active-terminal choice would let this command speak as a sibling worker.
    return await getTerminalHandle(flags, cwd, client, { requireUnambiguous: true })
  } catch (err) {
    if (!isNoActiveTerminalError(err)) {
      throw err
    }
    throwNoActiveSenderTerminal()
  }
}

// --from bypasses implicit resolution and could consume another pane's mailbox; never suggest it here.
function structuredSessionRefusal(flagName: 'from' | 'terminal'): RuntimeClientError {
  return new RuntimeClientError(
    'no_active_sender_terminal',
    `This chat session has no orchestration identity of its own, so --${flagName} cannot be inferred, ` +
      `and no terminal handle names it — every live handle belongs to a different pane, and passing one ` +
      `would consume that pane's mailbox. Drive a worker directly instead: create a worktree with ` +
      `--agent to launch one in its first terminal, then use terminal send and terminal read.`
  )
}

export function throwNoActiveSenderTerminal(): never {
  // Lifecycle sends can refuse before the structured guard; distinguish missing identity from stale handles.
  if (hasStructuredSessionMarker() && !process.env.ORCA_TERMINAL_HANDLE) {
    throw structuredSessionRefusal('from')
  }
  // Codex sets CODEX_THREAD_ID after the env filter that can drop Orca identity (#25775).
  if (process.env.CODEX_THREAD_ID && !process.env.ORCA_TERMINAL_HANDLE) {
    throw new RuntimeClientError(
      'no_active_sender_terminal',
      'Codex ran this orchestration command without ORCA_TERMINAL_HANDLE. If Codex was started in ' +
        'an Orca terminal, its shell_environment_policy removed it, and relaunching the same way ' +
        'will not restore it. Start Codex by typing `codex` in an Orca terminal, or set ' +
        'inherit = "all" with include_only listing the variables to keep plus "ORCA_*". ' +
        "Pass --from only with your own terminal's handle — another pane's handle would act on " +
        'its mailbox.'
    )
  }
  throw new RuntimeClientError(
    'no_active_sender_terminal',
    'Could not determine the sender terminal for this orchestration command. ' +
      "Pass --from with your own terminal's handle — another pane's handle would act on its mailbox — " +
      'or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set.'
  )
}
