import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../shared/process-table-snapshot'
import type { ShellForegroundProof } from '../providers/shell-foreground-proof'

/** The live row a verdict may act on: its last write, and the agent session that wrote it. */
export type CommandEndRowAnchor = {
  receivedAt: number
  agentType: string | undefined
  providerSessionId: string | null
}

/** The anchor of a pane's live row among the host's rows for that pane, if it has one. */
export function liveRowAnchor(
  rows: readonly AgentStatusIpcPayload[] | undefined
): CommandEndRowAnchor | null {
  const row = rows?.find((entry) => entry.providerSessionOnly !== true)
  return row
    ? {
        receivedAt: row.receivedAt,
        agentType: row.agentType,
        providerSessionId: row.providerSession?.id ?? null
      }
    : null
}

type CommandEndAgentExitDeps = {
  /** The PTY's pane keys whose host row is live (not a resume remnant), with that row's anchor. */
  readLiveRowAnchors(ptyId: string): Map<string, CommandEndRowAnchor>
  /** The hook presence check: the row's own agent pid and start time. An `exited` answer has
   *  already cleared that row; null when no hook identified a process. */
  checkHookAgentPresence(paneKey: string): Promise<AgentProcessVerdict | null>
  /** The execution host's answer on the pane's own shell, from evidence captured no earlier than
   *  `notCapturedBefore`; rejects when the host cannot be reached. */
  proveShellForeground(ptyId: string, notCapturedBefore: number): Promise<ShellForegroundProof>
  /** Clears a pane whose agent exited, unless its row changed after `armedRowReceivedAt`. */
  reconcileEndedProcess(paneKey: string, armedRowReceivedAt: number): void
  now(): number
}

/**
 * What a command end (OSC 133;D) says about the agent behind it. A full-screen agent's nested shells
 * leak their own 133;D, so the mark alone proves nothing where the host can look:
 * - `live`: the agent's own process is alive;
 * - `exited`: the pane's own shell is proven back in front;
 * - `other`: something else is proven in front, which ends with its own command end;
 * - `unread`: no trustworthy answer (unreachable host, unreadable or stale answer);
 * - `unprovable`: the host answered but cannot tell (a WSL guest, a Windows daemon or relay, an
 *   old daemon), so the mark is the only evidence there is.
 */
export type CommandEndExitVerdict = 'live' | 'exited' | 'other' | 'unread' | 'unprovable'

/** Why TEMPORARY for `unprovable`: the mark stands as the exit, so a nested shell's mark under a
 *  live TUI on those hosts drops its row. Loss of contact (`unread`) never clears a row. */
function clearsRow(verdict: CommandEndExitVerdict): boolean {
  return verdict === 'exited' || verdict === 'unprovable'
}

/** Re-asks for an unread answer: past the shared process-table cache's lifetime, then once more. */
const UNREAD_REASK_DELAYS_MS = [PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS + 100, 1_500]
/** Re-checks after a row was rewritten mid-check (often the exiting agent's own late hook). */
const REWRITE_RECHECKS = 2

export async function verifyCommandEndAgentExit(
  ptyId: string,
  paneKeys: Iterable<string>,
  notCapturedBefore: number,
  deps: Pick<CommandEndAgentExitDeps, 'checkHookAgentPresence' | 'proveShellForeground'>
): Promise<CommandEndExitVerdict> {
  const verdicts = await Promise.all(
    Array.from(paneKeys, (paneKey) => deps.checkHookAgentPresence(paneKey).catch(() => null))
  )
  if (verdicts.includes('live')) {
    return 'live'
  }
  let proof: ShellForegroundProof
  try {
    proof = await deps.proveShellForeground(ptyId, notCapturedBefore)
  } catch {
    return 'unread'
  }
  return proof === 'shell' ? 'exited' : proof
}

function sameAgentSession(armed: CommandEndRowAnchor, current: CommandEndRowAnchor): boolean {
  // Why a null session never matches: then a new agent of the same type cannot be told apart.
  return (
    armed.providerSessionId !== null &&
    armed.providerSessionId === current.providerSessionId &&
    armed.agentType === current.agentType
  )
}

type RunState = {
  rerun: boolean
  cancelled: boolean
  wake: (() => void) | null
}

/**
 * Re-derives every command end, for every PTY whose panes hold a live row, whether its agent exited.
 * Nothing is latched: a kept row is asked about again at the PTY's next command end, and an unread
 * answer a bounded number of times before that.
 */
export class CommandEndAgentExitVerifier {
  private readonly running = new Map<string, RunState>()

  constructor(private readonly deps: CommandEndAgentExitDeps) {}

  onCommandEnd(ptyId: string): void {
    const running = this.running.get(ptyId)
    if (running) {
      // Why rerun, not skip: this mark may be the real exit, after the in-flight read saw the agent.
      running.rerun = true
      running.wake?.()
      return
    }
    this.run(ptyId).catch((error: unknown) => {
      console.error('[agent-status] command-end exit check failed', { ptyId, error })
    })
  }

  /** The PTY's own teardown settles its rows; drop any pending re-ask. */
  onPtyExit(ptyId: string): void {
    const running = this.running.get(ptyId)
    if (running) {
      running.cancelled = true
      running.wake?.()
    }
  }

  private async run(ptyId: string): Promise<void> {
    const state: RunState = { rerun: true, cancelled: false, wake: null }
    this.running.set(ptyId, state)
    try {
      while (state.rerun && !state.cancelled) {
        state.rerun = false
        await this.verifyOnce(ptyId, state)
      }
    } finally {
      this.running.delete(ptyId)
    }
  }

  private async verifyOnce(ptyId: string, state: RunState): Promise<void> {
    const commandEndedAt = this.deps.now()
    let reasks = 0
    let rechecks = 0
    while (!state.cancelled) {
      const anchors = this.deps.readLiveRowAnchors(ptyId)
      if (anchors.size === 0) {
        return
      }
      const verdict = await verifyCommandEndAgentExit(
        ptyId,
        anchors.keys(),
        commandEndedAt,
        this.deps
      )
      if (clearsRow(verdict)) {
        const rewritten = this.clearUnchangedRows(ptyId, anchors, verdict)
        if (!rewritten || rechecks >= REWRITE_RECHECKS) {
          return
        }
        rechecks += 1
        continue
      }
      if (verdict !== 'unread' || reasks >= UNREAD_REASK_DELAYS_MS.length || state.rerun) {
        return
      }
      await this.wait(state, UNREAD_REASK_DELAYS_MS[reasks])
      reasks += 1
      if (state.rerun) {
        return
      }
    }
  }

  /** Clears each pane whose row is as armed, and says whether a row rewritten mid-check needs
   *  another look. After a proven exit any rewrite does: a new agent reads as in front. Where the
   *  host cannot tell, the look would answer the same, so only the exiting session's own late hook
   *  earns one and a different session's row is left alone. */
  private clearUnchangedRows(
    ptyId: string,
    anchors: Map<string, CommandEndRowAnchor>,
    verdict: CommandEndExitVerdict
  ): boolean {
    const current = this.deps.readLiveRowAnchors(ptyId)
    let rewritten = false
    for (const [paneKey, armed] of anchors) {
      const now = current.get(paneKey)
      if (now && now.receivedAt !== armed.receivedAt) {
        rewritten ||= verdict === 'exited' || sameAgentSession(armed, now)
        continue
      }
      try {
        this.deps.reconcileEndedProcess(paneKey, armed.receivedAt)
      } catch (error) {
        // Why per pane: one pane's failed clear must not strand its siblings' rows.
        console.error('[agent-status] command-end exit clear failed', { ptyId, paneKey, error })
      }
    }
    return rewritten
  }

  private wait(state: RunState, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.wake = null
        resolve()
      }, delayMs)
      timer.unref?.()
      state.wake = () => {
        clearTimeout(timer)
        state.wake = null
        resolve()
      }
    })
  }
}
