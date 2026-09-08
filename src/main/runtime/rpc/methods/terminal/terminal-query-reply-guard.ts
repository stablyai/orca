import { isTerminalQueryReply } from '../../../../../shared/terminal-query-reply'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { TerminalViewportClient } from './terminal-stream-types'

type TerminalQueryReplyIdentity = {
  text: string | undefined
  client: TerminalViewportClient | undefined
  /**
   * Authenticated device token when the transport carries one; the declared client id must match it.
   * Required (not optional) so a new call site cannot silently fall back to the declared id.
   */
  connectionClientId: string | undefined
}

/**
 * Client id allowed to author this query reply, or null when the request is not a
 * well-formed reply from an identified mobile client. Shared so the JSON
 * `terminal.send` path and the binary opcode-18 frame paths cannot drift.
 */
export function resolveTerminalQueryReplyAuthorId(args: TerminalQueryReplyIdentity): string | null {
  const authorId = args.connectionClientId ?? args.client?.id
  if (
    !args.text ||
    !isTerminalQueryReply(args.text) ||
    args.client?.type !== 'mobile' ||
    !authorId ||
    (args.connectionClientId !== undefined && args.client.id !== args.connectionClientId)
  ) {
    return null
  }
  return authorId
}

/**
 * Whole guard for a binary query-reply frame: reply grammar, mobile identity, and
 * reply authority. A frame that fails is dropped, matching what the JSON path does
 * for the same failures (throw on shape, `accepted: false` on authority).
 */
export function isAcceptableTerminalQueryReplyFrame(
  args: TerminalQueryReplyIdentity & {
    runtime: Pick<OrcaRuntimeService, 'isMobileTerminalQueryReplyAuthority'>
    ptyId: string | undefined
  }
): boolean {
  const authorId = resolveTerminalQueryReplyAuthorId(args)
  if (!authorId || !args.ptyId) {
    return false
  }
  return args.runtime.isMobileTerminalQueryReplyAuthority(args.ptyId, authorId)
}
