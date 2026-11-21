import { CodexAppServerRequestError } from '../codex-app-server-request-error'
import { CodexAppServerTimeoutError } from '../codex-app-server-session'
import { DEFAULT_CODEX_REQUEST_TIMEOUT_MS } from '../codex-app-server-connection'
import {
  codexChildThreadIdsInHistory,
  codexOpenedThreadId,
  codexTurnId
} from './codex-shared-server-frames'
import type { CodexSharedLeaseHost } from './codex-shared-server-lease'

const OPENS_THREAD = new Set(['thread/start', 'thread/resume', 'thread/fork'])
const CARRIES_HISTORY = new Set(['thread/resume', 'thread/read', 'thread/turns/list'])

/** Codex sets this on every command a chat's threads run, so its leftovers are found by lease. */
export const CODEX_SHARED_LEASE_ENV = 'ORCA_CODEX_SHARED_LEASE'

type RequestOptions = { timeoutMs?: number | null; onReply?: (result?: unknown) => void }

/** What a lease's requests need from the lease itself. */
export type CodexLeaseRequestOwner = {
  readonly id: string
  readonly open: boolean
  readonly host: CodexSharedLeaseHost
  /** thread/start, /resume and /fork still awaiting Codex; close waits for them. */
  readonly pendingOpens: Set<Promise<unknown>>
  /** Rejects every caller still waiting when the lease ends. */
  readonly outstanding: Set<(error: Error) => void>
  /** Threads this chat holds now. */
  readonly threads: ReadonlySet<string>
  claim: (threadId: string) => void
  heldByOther: (threadId: string) => boolean
  /** Drops this chat's own claim on a thread it failed to open. */
  unclaim: (threadId: string) => void
  /** Re-checks the server's backlog now that this chat waits on a reply. */
  noteWaiting: () => void
  abandon: (threadId: string) => void
}

function withLeaseTag(
  params: Record<string, unknown> | undefined,
  leaseId: string
): Record<string, unknown> {
  const config =
    typeof params?.config === 'object' && params.config !== null && !Array.isArray(params.config)
      ? params.config
      : {}
  return {
    ...params,
    config: { ...config, [`shell_environment_policy.set.${CODEX_SHARED_LEASE_ENV}`]: leaseId }
  }
}

/** One request of a chat on a shared server: routing claims, turn tracking, and an open whose
 *  answer arrives after its caller gave up still being let go. */
export async function sendCodexLeaseRequest(
  owner: CodexLeaseRequestOwner,
  method: string,
  params: Record<string, unknown> | undefined,
  options: RequestOptions
): Promise<unknown> {
  const { host } = owner
  const opensThread = OPENS_THREAD.has(method)
  const resumed =
    method === 'thread/resume' && typeof params?.threadId === 'string' ? params.threadId : null
  let resumedNewly = false
  if (resumed) {
    // A chat leaving this thread finishes its cleanup first, so it can't stop this one's work.
    await host.threadReleased(resumed)
    if (!owner.open) {
      throw new Error(`codex app-server connection is closed (${method})`)
    }
    // Separate servers refuse a second writer this way; one server would hand the thread over.
    if (owner.heldByOther(resumed)) {
      const detail = `thread ${resumed} already has an active writer`
      throw new CodexAppServerRequestError(
        method,
        -32600,
        `codex app-server ${method} failed: ${detail}`,
        detail
      )
    }
    resumedNewly = !owner.threads.has(resumed)
    owner.claim(resumed)
  }
  const turnThreadId =
    method === 'turn/start' && typeof params?.threadId === 'string' ? params.threadId : null
  let callerGone = false
  const sent = host.connection.request(
    method,
    opensThread ? withLeaseTag(params, owner.id) : params,
    {
      // An open is timed here, not by the transport, so a late answer still reaches onReply.
      timeoutMs: opensThread
        ? null
        : options.timeoutMs === undefined
          ? DEFAULT_CODEX_REQUEST_TIMEOUT_MS
          : options.timeoutMs,
      // Claimed before the reply's continuation, so frames Codex sent first reach this chat first.
      onReply: (result) => {
        const threadId = opensThread ? codexOpenedThreadId(result) : null
        if (threadId) {
          if (owner.open && !callerGone) {
            owner.claim(threadId)
          } else {
            owner.abandon(threadId)
          }
        }
        if (CARRIES_HISTORY.has(method) && owner.open && !callerGone) {
          for (const child of codexChildThreadIdsInHistory(result)) {
            owner.claim(child)
          }
        }
        const turnId = turnThreadId ? codexTurnId(result) : null
        if (turnThreadId && turnId) {
          host.noteTurnStarted(turnThreadId, turnId)
        }
        options.onReply?.(result)
      }
    }
  )
  if (turnThreadId) {
    host.trackTurnStart(turnThreadId, sent)
  }
  if (opensThread) {
    owner.pendingOpens.add(sent)
    const settle = (): void => {
      owner.pendingOpens.delete(sent)
      host.turnsChanged()
      host.router.openSettled()
    }
    sent.then(settle, settle)
  }
  const openTimeoutMs = opensThread
    ? options.timeoutMs === undefined
      ? DEFAULT_CODEX_REQUEST_TIMEOUT_MS
      : options.timeoutMs
    : null
  return await new Promise<unknown>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = (error: Error): void => {
      callerGone = true
      clearTimeout(timer)
      owner.outstanding.delete(giveUp)
      reject(error)
    }
    owner.outstanding.add(giveUp)
    owner.noteWaiting()
    if (openTimeoutMs !== null) {
      timer = setTimeout(
        () =>
          giveUp(
            new CodexAppServerTimeoutError(`codex app-server ${method} exceeded ${openTimeoutMs}ms`)
          ),
        openTimeoutMs
      )
    }
    sent.then(
      (result) => {
        clearTimeout(timer)
        owner.outstanding.delete(giveUp)
        resolve(result)
      },
      (error: unknown) => {
        clearTimeout(timer)
        owner.outstanding.delete(giveUp)
        // Codex opened nothing, so another chat may still open this thread here.
        if (resumed && resumedNewly) {
          owner.unclaim(resumed)
        }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}
