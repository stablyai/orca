import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { resolveTerminalTitlePolicyAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'
import {
  isCurrentCommandStatus,
  type TerminalCommandPaintRecord
} from '../input/terminal-command-paint'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'

/** A read that proved nothing (a slow or failed owner) is tried again after this, while quiet. */
const READ_RETRY_MS = 30_000

type RestTitlePty = TerminalCommandPaintRecord & {
  ptyId: string
  lastOscTitle?: string | null
  lastOscTitleEpochMs?: number | null
  adoptedRootProcess?: { pid: number } | null
}

/** The agent whose rest title a reattached pane still shows and the fence still masks: the only
 *  ready evidence a quiet agent that reads no screen leaves across a restart. That title can outlive
 *  its agent (a Claude that exited leaves `✳` over the shell, whose prompt redraw is paint), so it
 *  counts only when a fresh foreground read names this agent; null once any command boundary,
 *  current title or admitted report decides instead. */
export function reattachedRestTitleAgent(pty: Omit<RestTitlePty, 'ptyId'>): TuiAgent | null {
  const title = pty.lastOscTitle
  if (
    !title ||
    !pty.commandPaint?.awaitsReattachedCommand() ||
    isCurrentCommandStatus(pty, pty.lastOscTitleEpochMs) ||
    detectExplicitIdleStatusFromTitle(title) !== 'idle'
  ) {
    return null
  }
  const agent = resolveTerminalTitlePolicyAgentType(title)
  return isTuiAgent(agent) ? agent : null
}

/** One foreground read per pane per quiet stretch (or retry interval), for pending waits only, so a
 *  restart pays no fleet-wide process reads. Shared by every wait on a pane. */
export class ReattachedRestTitleReads<Pty extends RestTitlePty> {
  private readonly lastReadByPtyId = new Map<
    string,
    { outputClockAt: number | null; rootPid: number | null; at: number }
  >()
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly outputClockOf: (pty: Pty) => number | null,
    private readonly confirmRestTitle?: (ptyId: string, agent: TuiAgent) => Promise<boolean>
  ) {}

  /** Null when there is nothing to ask now; else whether the rest title's own agent was confirmed
   *  in front, with the pane unchanged, and its idle admitted. */
  confirm(pty: Pty): Promise<boolean> | null {
    const agent = reattachedRestTitleAgent(pty)
    if (!agent || !this.confirmRestTitle || this.inFlight.has(pty.ptyId)) {
      return null
    }
    const outputClockAt = this.outputClockOf(pty)
    // Why the root too: an old owner's read needs it, and discovery can store it after a failed read.
    const rootPid = pty.adoptedRootProcess?.pid ?? null
    const last = this.lastReadByPtyId.get(pty.ptyId)
    if (
      last?.outputClockAt === outputClockAt &&
      last.rootPid === rootPid &&
      Date.now() - last.at < READ_RETRY_MS
    ) {
      return null
    }
    this.lastReadByPtyId.set(pty.ptyId, { outputClockAt, rootPid, at: Date.now() })
    this.inFlight.add(pty.ptyId)
    return this.confirmRestTitle(pty.ptyId, agent)
      .catch(() => false)
      .finally(() => this.inFlight.delete(pty.ptyId))
  }

  /** The pane's last wait ended. */
  forget(ptyId: string): void {
    this.lastReadByPtyId.delete(ptyId)
  }
}
