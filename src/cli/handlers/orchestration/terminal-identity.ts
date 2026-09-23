import type { RuntimeClient } from '../../runtime-client'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { getTerminalHandle } from '../../selectors'
import { isStructuredSessionWithoutIdentity } from '../../../shared/structured-session-marker'
import { readInjectedAgentSessionId } from '../../../shared/agent-session-caller-env'
import { normalizeOrchestrationActor } from '../../../shared/orchestration-actor'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'

/**
 * The caller's terminal handle, or `undefined` when an injected agent session id names the caller:
 * the orchestration envelope carries that id and the host binds the caller param to it, so nothing
 * is resolved or guessed here.
 */
export async function resolveOrchestrationTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  flagName: 'from' | 'terminal',
  options: { validateEnvHandle?: boolean } = {}
): Promise<string | undefined> {
  if (resolveInjectedSessionCaller(flags, flagName)) {
    return undefined
  }
  const explicit = getOptionalStringFlag(flags, flagName)
  if (explicit) {
    return explicit
  }
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (envHandle && envHandle.length > 0) {
    if (flagName === 'from' && options.validateEnvHandle) {
      // Why: long-lived shells can retain a stale ORCA_TERMINAL_HANDLE after remint; don't bake it into coordinator preambles.
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
  // Past this point every remaining route GUESSES an implicit terminal, and a structured session
  // has no pane for the guess to land on — so it lands on a sibling. `check` is destructive by
  // default, so that guess consumed another pane's oldest unread batch and marked it read, and the
  // rightful worker never saw its mail. Refusing is the only honest answer: this child genuinely
  // cannot infer its own identity.
  if (isStructuredSessionWithoutIdentity()) {
    throw structuredSessionRefusal(flagName)
  }
  if (flagName === 'from') {
    return await resolveImplicitOrchestrationSender(flags, cwd, client)
  }
  return await getTerminalHandle(flags, cwd, client)
}

/**
 * Whether the handle this process was born with still names a live identity.
 *
 * `terminal.resolveIdentity`, never `terminal.show`: `show` is a PTY verb, so it missed for a
 * structured worker and reported `terminal_handle_stale` for a handle that was perfectly live —
 * which then failed every coordinator verb, because the pane remint below needs an `ORCA_PANE_KEY`
 * a structured child deliberately does not carry.
 */
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
      // Clients and remote hosts update independently, so a host that predates the identity probe
      // is the normal mixed-version state. Fall back to what it does have — which is correct for
      // that host, because a host without the probe also has no structured workers to miss.
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
    // Why: pane-key reminting preserves caller identity; focus-based active-terminal fallback can point at a different pane.
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

/**
 * The injected session id when this command runs as an agent session. The id wins over every other
 * identity this process carries; a caller flag may restate that same session but never name
 * another, and a conflicting one is refused here, before any request is sent.
 */
function resolveInjectedSessionCaller(
  flags: Map<string, string | boolean>,
  flagName: 'from' | 'terminal'
): string | undefined {
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    return undefined
  }
  const declared = getOptionalStringFlag(flags, flagName)
  if (declared !== undefined && !namesInjectedSession(declared, sessionId)) {
    throw new RuntimeClientError(
      'consumer_fenced',
      `This command runs as agent session ${sessionId}, so --${flagName} ${declared} would act as a ` +
        `different caller. Drop --${flagName}: this session's orchestration commands already act as ` +
        `session:${sessionId}. No request was sent.`
    )
  }
  return sessionId
}

/** The session's own spellings, plus the handle a structured worker session was minted. */
function namesInjectedSession(value: string, sessionId: string): boolean {
  return normalizeOrchestrationActor(value)?.id === sessionId || value === injectedSessionAddress()
}

/**
 * The address the host gives this session: a structured worker keeps the handle it was minted, any
 * other session is `session:<id>`. Only for text that must match what the host writes.
 */
export function injectedSessionAddress(): string | undefined {
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    return undefined
  }
  const ownHandle = process.env.ORCA_TERMINAL_HANDLE
  return isStructuredWorkerHandle(ownHandle) ? ownHandle : `session:${sessionId}`
}

/** How check output names its caller: the handle, or the session's address. */
export function orchestrationCallerLabel(handle: string | undefined): string {
  return handle ?? injectedSessionAddress() ?? 'unknown'
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
    // Unambiguous: naming the sender is an identity claim, so an arbitrary pick would let this
    // command speak as a sibling worker.
    return await getTerminalHandle(flags, cwd, client, { requireUnambiguous: true })
  } catch (err) {
    if (!isNoActiveTerminalError(err)) {
      throw err
    }
    throwNoActiveSenderTerminal()
  }
}

/**
 * Why no flag is suggested: every caller reaches a refusal only after the explicit-flag branch has
 * already returned, so `--from` advice would succeed — against a handle that necessarily belongs to
 * another pane, whose unread mail the next `check` consumes.
 */
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
  // Lifecycle sends refuse here before the structured guard above ever runs, so this is the only
  // place left that would tell an identity-less session to pass a handle it does not have. A stale
  // ORCA_TERMINAL_HANDLE is a different case — that caller HAS an identity, so it keeps the advice
  // to re-run under a live one.
  if (isStructuredSessionWithoutIdentity() && !process.env.ORCA_TERMINAL_HANDLE) {
    throw structuredSessionRefusal('from')
  }
  throw new RuntimeClientError(
    'no_active_sender_terminal',
    'Could not determine the sender terminal for this orchestration command. ' +
      "Pass --from with your own terminal's handle — another pane's handle would act on its mailbox — " +
      'or run the command inside a live Orca terminal with ORCA_TERMINAL_HANDLE set.'
  )
}
