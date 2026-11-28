import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import { registerPooledProviderRelayChat } from '../../../provider-relay/app-provider-relays'

/** A release's outcome: whether the chat's turns are proven over (else it stays on the server for
 *  a retry), and whether its commands are proven gone. */
export type CodexLeaseRelease = { writerStopped: boolean; workloadGone: boolean }

/** What a lease needs from the server it rides on. */
export type CodexSharedLeaseHost = {
  readonly pid: number | undefined
  readonly closed: boolean
  readonly connection: CodexAppServerConnection
  claim: (
    threadId: string,
    lease: CodexSharedServerLease,
    opened?: boolean,
    history?: boolean
  ) => void
  /** This chat's queue grew or shrank by these bytes, or it may have started waiting (0). */
  backlog: (lease: CodexSharedServerLease, deltaBytes: number) => void
  /** Answers a server request no chat will take, so Codex doesn't wait on it. */
  refuse: (frame: CodexSharedServerFrame) => void
  /** True the first time an answer to this request may be sent (one answer per request). */
  answer: (id: number | string) => boolean
  /** Whether any of these threads has a turn running. */
  hasRunningTurn: (threads: Iterable<string>) => boolean
  /** A thread open or turn start settled, so a wait on them can re-check. */
  turnsChanged: () => void
  /** Settles once a retried release could prove more: a turn ended, another chat left, or the
   *  server exited. */
  releaseMayProve: (lease: CodexSharedServerLease) => Promise<unknown>
  readonly router: Pick<CodexSharedServerRouter, 'heldByOther' | 'unclaim' | 'openSettled'>
  /** A thread that opened after its chat left: nobody will use it, so the server lets it go.
   *  Resolves whether Codex confirmed it. */
  abandon: (threadId: string, lease: CodexSharedServerLease) => Promise<boolean>
  /** Settles once no chat leaving the server is still cleaning up this thread. */
  threadReleased: (threadId: string) => Promise<void>
  /** Records a turn/start in flight, so a release that races it still interrupts its turn. */
  trackTurnStart: (threadId: string, request: Promise<unknown>) => void
  noteTurnStarted: (threadId: string, turnId: string) => void
  release: (lease: CodexSharedServerLease) => Promise<CodexLeaseRelease>
  /** After the server exited: whether its commands were proven gone, once reaped. */
  workloadVerdict: () => DescendantTreeVerdict
  afterReap: () => Promise<void>
  /** Present when the daemon runs the server, so it can outlive this app. */
  readonly relay?: CodexSharedLeaseRelay
}

/** What a lease on a relayed server needs from it beyond its frames. */
export type CodexSharedLeaseRelay = {
  /** Quit: this chat's part goes on under the daemon; nothing of it is stopped. */
  detachForQuit: (lease: CodexSharedServerLease) => Promise<void>
  /** The chat left stopping nothing: its threads go unclaimed, and the requests it was handed but
   *  didn't answer wait for the thread's next chat. */
  leftQuietly: (lease: CodexSharedServerLease) => void
}

/** What a chat sees of the daemon running its shared server; absent when its run ends with this
 *  app. A kept run is rebuilt from Codex (thread/resume), never from replayed output. */
export function codexSharedLeaseRelayView(
  lease: CodexSharedServerLease
): CodexAppServerConnection['relay'] {
  if (!lease.host.relay || !lease.keepable) {
    return undefined
  }
  return {
    reattached: false,
    ownServer: false,
    releaseOutput: () => {},
    endedWork: () => undefined,
    openWork: () => undefined
  }
}

/** Quit and reopen read a pooled chat through the provider relay's per-chat view. */
export function registerCodexSharedLeaseChat(
  lease: CodexSharedServerLease,
  live: () => boolean
): () => void {
  const { sessionId } = lease
  if (sessionId === null) {
    return () => {}
  }
  // Read when asked: a server whose relay fell back to a direct spawn keeps nothing past quit.
  return registerPooledProviderRelayChat(sessionId, {
    // The same writer as its kept run: its running turn is not old work to sweep.
    reattached: () => lease.restored && live() && lease.host.relay !== undefined,
    keepable: () => lease.keepable && live() && lease.host.relay !== undefined,
    detachForQuit: async () => {
      await lease.host.relay?.detachForQuit(lease)
      return true
    }
  })
}

/** Hands one frame to the chat; a handler that throws ends that chat alone, never the reader. */
export function dispatchCodexLeaseFrame(
  handlers: CodexAppServerConnectionHandlers,
  frame: CodexSharedServerFrame,
  fail: (error: Error) => void
): void {
  try {
    if (frame.kind === 'request') {
      handlers.onServerRequest?.(frame.request)
    } else if (frame.kind === 'unhandled') {
      handlers.onUnhandledFrame?.(frame.frameKind, frame.payload)
    } else {
      handlers.onNotification?.(frame.method, frame.params)
    }
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)))
  }
}

/** The chat left stopping nothing of its run. What it never saw is dropped (Codex has it), and its
 *  unanswered requests wait for the thread's next chat. */
export function endCodexLeaseQuietly(lease: CodexSharedServerLease): void {
  lease.unregister()
  lease.queue.take()
  for (const giveUp of lease.outstanding) {
    giveUp(new Error('codex app-server connection closed'))
  }
  lease.host.relay?.leftQuietly(lease)
}
