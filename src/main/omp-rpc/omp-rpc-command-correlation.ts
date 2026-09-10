import type { OmpRpcCommand } from '../../shared/omp-rpc-protocol'
import { OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS } from './omp-rpc-transport-limits'

export type OmpRpcPendingResponse = {
  command: OmpRpcCommand['type']
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  /** Cleared whenever the request settles, so a late response never fires a
   *  timeout that has nothing left to reject. */
  timeout?: ReturnType<typeof setTimeout>
  acknowledgedData?: unknown
  hasAcknowledged?: boolean
  hasTurnTerminal?: boolean
  terminalAgentInvoked?: boolean
}

/** Commands whose reply is turn-scoped, not a query: upstream answers `prompt`
 *  only once a skill or builtin slash command has finished running (`rpc-mode.ts`
 *  awaits `tryRunRpcSkillCommand`/`executeAcpBuiltinSlashCommand` before
 *  replying), and steer/follow_up are answered by the running turn. A deadline
 *  there would abandon live work; every wait XLR-016 has to bound (settle,
 *  release, the acquire queued behind it) is built on the query commands. */
const OMP_RPC_TURN_SCOPED_COMMANDS: ReadonlySet<OmpRpcCommand['type']> = new Set([
  'prompt',
  'steer',
  'follow_up'
])

/** Starts the response deadline for a request already registered as `id`
 *  (XLR-016, cross-lab review). A child that is alive and reading stdin but has
 *  stopped answering left the promise pending forever, and every bounded wait
 *  downstream (the settle poll, the release that follows it, the acquire queued
 *  behind that release) is built on one of these reads. Turn-scoped commands
 *  are left alone; the caller keeps the request id reserved, so a reply that
 *  arrives after the deadline is reported as an unknown frame rather than
 *  settling a caller that has already given up. */
export function armOmpRpcResponseDeadline(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  id: string,
  pending: OmpRpcPendingResponse
): void {
  if (OMP_RPC_TURN_SCOPED_COMMANDS.has(pending.command)) {
    return
  }
  pending.timeout = setTimeout(() => {
    if (pendingResponses.get(id) !== pending) {
      return
    }
    pendingResponses.delete(id)
    pending.reject(
      new Error(
        `OMP RPC ${pending.command} did not answer within ${OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS}ms`
      )
    )
  }, OMP_RPC_COMMAND_RESPONSE_TIMEOUT_MS)
  pending.timeout.unref?.()
}

/** Prefix of the auto-allocated request ids. A caller-supplied id must not
 *  look like one, or two different commands could share a wire id and the
 *  wrong one would settle. */
const AUTO_REQUEST_ID_PREFIX = 'orca-omp-'

/**
 * The wire `id` for one outbound command. A caller may supply its own so it can
 * attribute a later server-pushed frame (`prompt_result`) to the run that
 * issued the prompt; upstream echoes the id it received. Anything that could
 * alias a command already issued on this client is refused rather than silently
 * renamed, because a late server-push frame can otherwise mutate a later run.
 * `sequenceNumber`
 * is consumed even when a caller supplies its own id — the sequence only has to
 * be unique, not gapless.
 */
export function resolveOmpRpcRequestId(
  requestId: string | undefined,
  sequenceNumber: number,
  isIssued: (id: string) => boolean
): string | { error: string } {
  if (requestId === undefined) {
    return `${AUTO_REQUEST_ID_PREFIX}${sequenceNumber}`
  }
  return !requestId || requestId.startsWith(AUTO_REQUEST_ID_PREFIX) || isIssued(requestId)
    ? { error: `OMP RPC refused an unusable request id: ${requestId || '(empty)'}` }
    : requestId
}

/** Takes a pending request off the table, matching the answering frame's own
 *  `command` — a mismatch is not this request's answer and is left pending.
 *  Also disarms the response deadline: an expired timer is inert anyway (it
 *  re-checks the table before rejecting), but a settled request has no reason
 *  to keep one armed. */
export function settleOmpRpcPendingResponse(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  id: string,
  command: unknown
): OmpRpcPendingResponse | undefined {
  const pending = pendingResponses.get(id)
  if (!pending || command !== pending.command) {
    return undefined
  }
  pendingResponses.delete(id)
  clearTimeout(pending.timeout)
  return pending
}

/** Fails every in-flight request at once (transport death, protocol fault,
 *  dispose), disarming their deadlines with them. */
export function rejectAllOmpRpcPendingResponses(
  pendingResponses: Map<string, OmpRpcPendingResponse>,
  error: Error
): void {
  const pending = [...pendingResponses.values()]
  pendingResponses.clear()
  for (const request of pending) {
    clearTimeout(request.timeout)
    request.reject(error)
  }
}

export class OmpRpcCommandError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'OmpRpcCommandError'
  }
}
