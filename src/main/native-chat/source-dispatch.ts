// Routes a native chat subscription to the transport that carries the agent's
// conversation: the JSONL transcript watcher, or an ACP session.
//
// Why a dispatcher rather than a branch inside transcript-watch: the file
// watcher's whole surface (resolve polling, rotation retry, reconciliation) is
// meaningless for a pipe, and an ACP client has no file to reconcile against.
// Keeping them as sibling implementations of one contract means neither grows
// conditionals for the other's failure modes.

import { resolveNativeChatTransport } from '../../shared/native-chat-agent-support'
import type { ReadTranscriptResult } from './transcript-reader'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript
} from './transcript-watch'
import { subscribeNativeChatAcpSession, type SubscribeAcpArgs } from './acp-source'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'

export type SubscribeNativeChatSessionArgs = SubscribeAcpArgs

/** Subscribe to an agent's conversation over whichever transport it serves. */
export async function subscribeNativeChatSession(
  args: SubscribeNativeChatSessionArgs
): Promise<NativeChatTranscriptSubscription> {
  if (resolveNativeChatTransport(args.agent) === 'acp') {
    return subscribeNativeChatAcpSession(args)
  }
  return subscribeNativeChatTranscript(args)
}

/** Mirrors readNativeChatTranscriptTail's parameters so the dispatcher stays a
 *  pass-through for the transcript path (`limit` is required there — the caller
 *  clamps it before dispatch). */
export type ReadNativeChatSessionTailArgs = Parameters<typeof readNativeChatTranscriptTail>[0]

/**
 * Read a window of history for the pagination path.
 *
 * ACP has no file to page through: `session/load` replays the whole
 * conversation as notifications when the subscription opens, so history is
 * already delivered by the time a reader would ask. Returning an empty result
 * (not an error) keeps the renderer's "no more to load" path intact.
 */
export async function readNativeChatSessionTail(
  args: ReadNativeChatSessionTailArgs
): Promise<ReadTranscriptResult> {
  if (resolveNativeChatTransport(args.agent) === 'acp') {
    return { messages: [] }
  }
  return readNativeChatTranscriptTail(args)
}
