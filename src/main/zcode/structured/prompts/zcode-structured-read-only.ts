// A read-only ZCode session (a bot's look-around or tidy-up) is held by an allow-list of tools, which
// ZCode applies when it registers its own tools and to every server's, at a session's create and at
// its resume alike; an allow-list, so a tool a later ZCode adds stays out. Nothing here relies on an
// approval: nobody is watching to give one. (Checked live on ZCode 4.0.0: under it a write, a shell
// command and a subagent each answer `TOOL_NOT_FOUND`, and a server's tools are not offered at all.)
import {
  LOOK_AROUND_REFUSAL,
  REPLY_ONLY_REFUSAL,
  type ReadOnlySessionMode
} from '../../../bots/bot-look-around-policy'

// No shell in a look-around: ZCode answers a command's approval itself where a saved rule or a
// PermissionRequest hook says so, so the allow-list Orca keeps for commands would not see every one.
const LOOK_AROUND_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep']

/** The session's `toolAllowlist`: a look keeps what only reads; a reply-only run gets no tool. */
export function zcodeReadOnlyToolAllowlist(mode: ReadOnlySessionMode = 'look-around'): string[] {
  return mode === 'look-around' ? [...LOOK_AROUND_TOOLS] : []
}

/** The host's answer to a read-only session's request; null when it isn't one to answer here. */
export function zcodeReadOnlyAnswer(
  method: string,
  mode: ReadOnlySessionMode = 'look-around'
): Record<string, unknown> | null {
  const reason = mode === 'look-around' ? LOOK_AROUND_REFUSAL : REPLY_ONLY_REFUSAL
  switch (method) {
    case 'interaction/requestPermission':
      return { decision: 'deny', reason }
    case 'interaction/requestUserInput':
      return { action: 'decline', reason }
    default:
      return null
  }
}
