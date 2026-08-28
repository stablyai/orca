import type { AgentHookSource } from '../../shared/agent-hook-relay'

/** Correction — which supervised routes can be STOPPED before a tool runs.
 *
 *  Orca's PreToolUse hooks were telemetry: every managed script posts the event
 *  and discards the reply (`>/dev/null`), and Antigravity and Cursor print a
 *  canned decision BEFORE they post at all. A 204 on a fire-and-forget POST
 *  cannot stop anything, so a fence resting on it fences nothing.
 *
 *  Blocking needs three things at once: the provider must call the hook
 *  SYNCHRONOUSLY before the tool executes, it must have a deny channel in the
 *  hook's own reply, and Orca's script must actually read the reply. Only a
 *  route where all three hold can be fenced.
 *
 *  Everything else is `unsupported`, and unsupported must never certify as PASS.
 *  A route that cannot be stopped can still be made safe — by giving the work an
 *  isolated worktree, or by waiting for the lease — but that is a different
 *  answer and callers have to be told which one they got.
 */

export type PretoolBlockingCapability =
  | {
      /** The hook reply can deny the tool call before it runs. */
      kind: 'blocking'
      /** Content type of the deny body Orca returns to the managed script. */
      contentType: string
      /** Builds the provider's own deny payload. Orca does not invent a shape;
       *  this is the provider's documented PreToolUse deny contract. */
      denyBody: (reason: string) => string
    }
  | {
      kind: 'unsupported'
      /** Why this route cannot be stopped, in the caller's terms. */
      reason: string
    }

/** Claude Code's PreToolUse contract: the hook's stdout may carry a
 *  `hookSpecificOutput` with `permissionDecision: "deny"`, and the tool is not
 *  run. Orca returns that body from the hook endpoint and the managed script
 *  prints it, so the deny travels the provider's own channel rather than a
 *  second one Orca invented. */
function claudeDenyBody(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })
}

const UNPROVEN =
  'Orca has not established a synchronous pre-tool deny channel for this route, so it cannot stop a mutation before it happens.'

const WINDOWS_FIRE_AND_FORGET =
  "Orca's installed Claude hook on this platform is a .cmd that posts the event and exits 0 without reading the reply, so a deny cannot reach the agent. Give the certification run an isolated worktree, or wait for the lease, until that script reads and propagates the decision."

/** Conservative by construction: a route is blocking only where this repository
 *  can point at the deny channel it uses AND at the installed script that
 *  actually consumes it. Adding a route here without wiring its managed script
 *  to READ the reply would re-create the exact false confidence this table
 *  exists to remove.
 *
 *  Capability is a property of the (agent, installed transport) pair, not of the
 *  agent alone. The POSIX Claude script captures the reply and exits 2 on a
 *  deny; the local Windows .cmd for the same agent still posts fire-and-forget
 *  and exits 0, so the same `claude` source is blocking on one platform and
 *  unsupported on the other. Reporting it as blocking everywhere admitted a
 *  Windows route as fenced when nothing there could stop a tool call. */
const CAPABILITY: Partial<Record<AgentHookSource, PretoolBlockingCapability>> = {
  claude: { kind: 'blocking', contentType: 'application/json', denyBody: claudeDenyBody }
}

export function pretoolBlockingCapability(
  source: AgentHookSource,
  platform: NodeJS.Platform = process.platform
): PretoolBlockingCapability {
  if (platform === 'win32') {
    // No Windows adapter is being built here. Until that script reads the reply,
    // the honest answer is that this route cannot be stopped before it mutates.
    return { kind: 'unsupported', reason: WINDOWS_FIRE_AND_FORGET }
  }
  return CAPABILITY[source] ?? { kind: 'unsupported', reason: UNPROVEN }
}

export function canBlockBeforeMutation(
  source: AgentHookSource,
  platform: NodeJS.Platform = process.platform
): boolean {
  return pretoolBlockingCapability(source, platform).kind === 'blocking'
}

/** Tools that can change the tree. A read cannot contaminate a running gate, and
 *  denying reads would make a fenced worker unable to even diagnose the fence.
 *
 *  Unknown tool names are treated as MUTATING: a tool Orca does not recognise is
 *  exactly the one whose effects it cannot bound.
 *
 *  `Task` is deliberately absent. It reads like a planning verb, but it spawns a
 *  subagent that runs Bash and Edit of its own — exempting it would hand a
 *  fenced worker a way to mutate the tree through a child. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookRead',
  'ListMcpResources',
  'ReadMcpResource'
])

export function toolCanMutate(toolName: string | null | undefined): boolean {
  if (!toolName) {
    return true
  }
  return !READ_ONLY_TOOLS.has(toolName)
}
