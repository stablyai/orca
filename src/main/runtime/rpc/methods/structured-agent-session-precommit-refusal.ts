// Nothing before `attach` commits a session, so every failure in that span definitively created
// nothing. Thrown, it reaches a remote client as a generic transport error, indistinguishable from
// an answer that was lost on the way back — and a client that cannot tell those apart either
// strands the user with no chat and no terminal, or spawns a sibling beside a session that may
// already exist. So the whole span answers with a refusal envelope carrying a code, whatever it
// failed on.
//
// Converting the span rather than each throw site is deliberate: alongside the throws that carry a
// code there is a code-less class — an unresolvable worktree, a store that will not open, a host
// that will not install — that no per-site list catches, and it is exactly the class that reaches
// the user as nothing at all.

import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from '../../../../shared/agent-session-wire'

export type StructuredCreateRefused = { refusal: AgentSessionWireRefusal }

/** A pre-commit failure with no code of its own still proves the host could not serve a structured
 *  session for this request and did not create one, which is what `unsupported` says on the wire.
 *  A new code would say it more precisely, but only to clients new enough to know it. */
const UNCODED_PRECOMMIT_REFUSAL_CODE: AgentSessionWireRefusalCode =
  'structured_agent_session_unsupported'

function wireRefusalCode(error: unknown): AgentSessionWireRefusalCode | null {
  const candidates = [
    error instanceof Error && 'code' in error ? (error as { code: unknown }).code : undefined,
    error instanceof Error ? error.message : String(error)
  ]
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      (AGENT_SESSION_WIRE_REFUSAL_CODES as readonly string[]).includes(candidate)
    ) {
      return candidate as AgentSessionWireRefusalCode
    }
  }
  return null
}

function precommitRefusal(error: unknown): AgentSessionWireRefusal {
  const code = wireRefusalCode(error)
  if (code) {
    return { code, message: 'Orca cannot open a structured agent chat for this workspace.' }
  }
  const message = error instanceof Error ? error.message : String(error)
  // A code-less failure here is often a defect, not a policy answer; the refusal keeps the user
  // moving, the log keeps the cause findable.
  console.warn('[agent-session] create refused before it committed anything', error)
  return {
    code: UNCODED_PRECOMMIT_REFUSAL_CODE,
    message: `Orca could not prepare a structured agent chat for this workspace: ${message}`
  }
}

/**
 * Runs the pre-commit half of a create. Anything it throws becomes a refusal; a refusal it returns
 * itself passes through. Must not wrap `attach` or anything after it — past that point a failure no
 * longer proves the session does not exist.
 */
export async function resolveUncommittedStructuredCreate<TPrepared>(
  prepare: () => Promise<TPrepared | StructuredCreateRefused>
): Promise<TPrepared | StructuredCreateRefused> {
  try {
    return await prepare()
  } catch (error) {
    return { refusal: precommitRefusal(error) }
  }
}
