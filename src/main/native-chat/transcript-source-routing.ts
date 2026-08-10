import type { AgentType } from '../../shared/native-chat-types'
import { isSshNativeChatUnchangedResult } from '../../shared/ssh-native-chat-relay'
import type { ResolveSessionFileOptions } from './session-file-resolver'
import { readSshNativeChatTranscript, resolveNativeChatSshOwner } from './ssh-transcript-host'
import { subscribeSshNativeChatTranscript } from './ssh-transcript-subscription'
import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription,
  type SubscribeNativeChatTranscriptArgs
} from './transcript-watch'

// Why: an agent running in an SSH worktree writes its transcript on the remote
// host, so the desktop's own filesystem never holds the file. Both native chat
// entry points (Electron IPC for the desktop renderer, runtime RPC for paired
// mobile/web clients) route through here so a session is read where it lives.
// Local sessions, including WSL guests reachable through a UNC twin, keep the
// local reader untouched.

export type RoutedReadTranscriptTailArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  filePath?: string
  limit: number
  beforeOffset?: number
}

const TRANSCRIPT_MISS = { error: 'Transcript unavailable', notFound: true } as const

export async function readRoutedNativeChatTranscriptTail(
  args: RoutedReadTranscriptTailArgs,
  signal?: AbortSignal
): ReturnType<typeof readNativeChatTranscriptTail> {
  const owner = routableOwner(args)
  if (!owner) {
    return readNativeChatTranscriptTail(args, signal)
  }
  const remote = await readSshNativeChatTranscript(
    owner.connectionId,
    {
      agent: args.agent,
      sessionId: args.sessionId,
      // Only the hook's own path is forwarded: a client-supplied path would let
      // any paired client name a file on the remote host.
      ...(owner.transcriptPath === undefined ? {} : { transcriptPath: owner.transcriptPath }),
      limit: args.limit,
      ...(args.beforeOffset === undefined ? {} : { beforeOffset: args.beforeOffset })
    },
    signal
  ).catch((error: unknown) => {
    // A cancelled read must stay cancelled; the local reader propagates it too.
    if (isAbortError(error)) {
      throw error
    }
    return null
  })
  if (remote && 'messages' in remote) {
    return remote
  }
  if (remote && 'error' in remote) {
    return remote
  }
  // This session is known to live on another machine, so a local read could only
  // hit a look-alike: the same session id, or the same absolute path under a
  // matching home layout. Report the miss instead of rendering another machine's
  // conversation. `unchanged` and `appended` cannot answer a windowed read.
  if (remote && !isSshNativeChatUnchangedResult(remote)) {
    return TRANSCRIPT_MISS
  }
  return TRANSCRIPT_MISS
}

export async function subscribeRoutedNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs,
  setupSignal?: AbortSignal
): Promise<NativeChatTranscriptSubscription> {
  const owner = routableOwner(args)
  if (!owner) {
    return subscribeNativeChatTranscript(args, setupSignal)
  }
  setupSignal?.throwIfAborted()
  // Mirrors subscribeNativeChatTranscript's own fast-fail: an agent with no
  // decoder or a blank session id can never resolve, so say so immediately
  // instead of polling a relay forever.
  if (!nativeChatLineDecoderForAgent(args.agent) || !args.sessionId.trim()) {
    return { unsubscribe: () => {}, watching: false }
  }
  return subscribeSshNativeChatTranscript(owner.connectionId, {
    ...args,
    ...(owner.transcriptPath === undefined ? {} : { transcriptPath: owner.transcriptPath })
  })
}

/** An explicit `filePath` is a host-local read (tests, already-resolved paths),
 *  so it is never routed to a relay. */
function routableOwner(args: {
  sessionId: string
  transcriptPath?: string
  filePath?: string
}): ReturnType<typeof resolveNativeChatSshOwner> {
  if (args.filePath) {
    return null
  }
  return resolveNativeChatSshOwner({
    sessionId: args.sessionId,
    ...(args.transcriptPath === undefined ? {} : { transcriptPath: args.transcriptPath })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
