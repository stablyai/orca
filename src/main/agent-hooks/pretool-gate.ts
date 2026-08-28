import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { pretoolBlockingCapability, toolCanMutate } from './pretool-blocking-capability'

/** Correction — the one place a supervised worker can be stopped BEFORE it
 *  mutates its worktree.
 *
 *  The hook endpoint answered 204 to everything and explicitly failed open, so a
 *  worker already running could edit and commit under a live validation lease.
 *  Nothing between the worker and the tree ever asked Orca a question it could
 *  answer with "no".
 *
 *  This decides whether THIS hook request is that moment, and if so renders the
 *  deny in the provider's own PreToolUse contract. Orca supplies the reason; the
 *  shape belongs to the provider.
 */

/** The pre-tool gate events across supported providers. Gemini calls it
 *  `BeforeTool`; the rest use Claude/Codex's `PreToolUse`. Post-tool events are
 *  deliberately absent: by then the mutation has happened, and treating one as a
 *  gate is how a decision gets fabricated out of an observation. */
const PRE_TOOL_GATE_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'BeforeTool'])

export function isPreToolGateEvent(hookEventName: string | undefined): boolean {
  return hookEventName !== undefined && PRE_TOOL_GATE_EVENTS.has(hookEventName)
}

export type PretoolMutationVerdict = { deny: false } | { deny: true; reason: string }

/** What the runtime must supply for the gate to mean anything. Every field is
 *  runtime-attested: the pane key is validated against the launch-token hash
 *  before this is reached, and the worktree comes from the metadata Orca itself
 *  wrote into the session's environment. */
export type PretoolGateRequest = {
  source: AgentHookSource
  hookEventName: string | undefined
  toolName: string | undefined
  paneKey: string
  worktreeId: string | undefined
  /** The session's launch token, as the managed script sent it. Compared against
   *  the Dispatch's stored hash by the resolver; never trusted as identity on
   *  its own. */
  launchToken: string | undefined
  /** Exact provider hook payload received on the synchronous pre-exec request.
   * It is runtime transport evidence; no public worker RPC may substitute it. */
  payload: Record<string, unknown>
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

/** Reads the gate's inputs from the ATTESTED hook body rather than from the
 *  normalized status event.
 *
 *  Why not the status event: normalization exists to decide what the dashboard
 *  should show, and it legitimately suppresses events — a retired pane, a replay,
 *  a closed tab. Suppressing a status update must never mean a mutation goes
 *  unfenced, and hanging the fence off that pipeline is how it would.
 *
 *  Providers disagree on casing (`hook_event_name` vs `hookEventName`), so both
 *  are read; a body that carries neither yields undefined and the gate declines,
 *  which is the same as today. */
export function readPretoolGateRequest(
  source: AgentHookSource,
  body: unknown
): PretoolGateRequest | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const envelope = body as Record<string, unknown>
  const paneKey = readString(envelope, 'paneKey')
  if (!paneKey) {
    return null
  }
  const payload =
    envelope.payload && typeof envelope.payload === 'object'
      ? (envelope.payload as Record<string, unknown>)
      : {}
  return {
    source,
    hookEventName: readString(payload, 'hook_event_name', 'hookEventName'),
    toolName: readString(payload, 'tool_name', 'toolName'),
    paneKey,
    worktreeId: readString(envelope, 'worktreeId'),
    launchToken: readString(envelope, 'launchToken'),
    payload
  }
}

export type PretoolGateResponse = {
  status: number
  contentType: string
  body: string
}

/** Returns the response that stops this tool call, or null to let the ordinary
 *  204 path run.
 *
 *  Null on every path the gate does not own — a non-gate event, a read-only
 *  tool, a route with no deny channel, an allow. The gate narrows; it never
 *  becomes the general reply. */
export function buildPretoolGateResponse(
  request: PretoolGateRequest,
  resolveVerdict: (request: PretoolGateRequest) => PretoolMutationVerdict
): PretoolGateResponse | null {
  if (!isPreToolGateEvent(request.hookEventName) || !toolCanMutate(request.toolName)) {
    return null
  }
  const capability = pretoolBlockingCapability(request.source)
  if (capability.kind !== 'blocking') {
    // Nothing Orca returns here would stop the tool, so returning a deny body
    // would be theatre: the worker would mutate anyway and the reply would be
    // discarded. Admission is where an unblockable route has to be refused.
    return null
  }
  const verdict = resolveVerdict(request)
  if (!verdict.deny) {
    return null
  }
  return {
    status: 200,
    contentType: capability.contentType,
    body: capability.denyBody(verdict.reason)
  }
}
