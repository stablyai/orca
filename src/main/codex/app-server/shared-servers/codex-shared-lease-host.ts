import type { DescendantTreeVerdict } from '../../../pty/process-retirement/pty-descendant-exit-verification'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from '../codex-app-server-connection-types'
import type { CodexSharedServerFrame } from './codex-shared-server-frames'
import type { CodexSharedServerRouter } from './codex-shared-server-router'
import type { CodexSharedServerLease } from './codex-shared-server-lease'
import type { CodexRecoveredChat } from './codex-shared-recovery-group'
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
  /** Work the daemon carried (open, or ended while no app was attached), every chat's. */
  openWork: () => Record<string, string[][]> | undefined
  endedWork: () => Record<string, string[][]> | undefined
  recordSeq: () => number | null
  /** Quit: this chat's part goes on under the daemon; nothing of it is stopped. */
  detachForQuit: (
    lease: CodexSharedServerLease,
    open: Record<string, string[][]> | null
  ) => Promise<void>
  /** The chat was handed a frame its journal may not hold yet. */
  dispatched: (lease: CodexSharedServerLease) => void
  /** A reattach that couldn't finish: its threads and frames wait for the chat's next open. */
  handBack: (lease: CodexSharedServerLease, frames: CodexSharedServerFrame[]) => void
}

/** A lease restored from a reattached server: its chat's commands keep their tag. */
export type CodexRestoredLease = { workload: string; chat: CodexRecoveredChat }

type Work = Record<string, string[][]> | undefined

/** The daemon's carried work, narrowed to this chat's threads (keys start with the thread). */
function narrowed(work: Work, threads: ReadonlySet<string>): Work {
  return (
    work &&
    Object.fromEntries(
      Object.entries(work).map(([group, keys]) => [
        group,
        keys.filter(([threadId]) => threadId !== undefined && threads.has(threadId))
      ])
    )
  )
}

/** What a chat sees of the daemon running its shared server; absent when its run ends with this app. */
export function codexSharedLeaseRelayView(
  lease: CodexSharedServerLease,
  reattached: boolean
): CodexAppServerConnection['relay'] {
  const relay = lease.host.relay
  if (!relay || !lease.keepable) {
    return undefined
  }
  return {
    reattached,
    ownServer: false,
    releaseOutput: () => releaseHeld(lease),
    endedWork: () => narrowed(relay.endedWork(), lease.threads),
    openWork: () => narrowed(relay.openWork(), lease.threads),
    recordSeq: relay.recordSeq,
    ...(lease.restored ? { keep: async () => lease.handBack() } : {})
  }
}

/** A restored chat read its kept state: its held frames go to it in order. */
function releaseHeld(lease: CodexSharedServerLease): void {
  if (lease.holding) {
    lease.holding = false
    lease.queue.drain()
    lease.noteWaiting()
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
    reattached: () => lease.restored !== null && live() && lease.host.relay !== undefined,
    keepable: () => lease.keepable && live() && lease.host.relay !== undefined,
    detachForQuit: async (open) => {
      await lease.host.relay?.detachForQuit(lease, open)
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

/** A restored chat's open ended without its run ending: what it hadn't seen goes back to wait. */
export function endCodexLeaseQuietly(lease: CodexSharedServerLease): void {
  lease.unregister()
  const frames = lease.queue.take()
  for (const giveUp of lease.outstanding) {
    giveUp(new Error('codex app-server connection closed'))
  }
  lease.host.relay?.handBack(lease, frames)
}
