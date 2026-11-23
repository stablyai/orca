// Who each background shell command the root agent launches is for, fixed at its launch: every input the turn
// had taken by then, in the order the stream shows them (the send that opened it, each send steered
// in, the runs that woke it or finished into it). A turn with an input Orca can't name records no
// more launches.
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import type { AgentJournalTurnItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { taskAliasId, taskId } from '../../background-tasks/claude-background-task-frames'
import { isClaudeInjectedUserMessage } from '../journal/claude-internal-message-content'
import type { FinishedBefore } from './claude-turn-wakes'
import type { ClaudeHandedSends } from '../claude-structured-session-state'
import type { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'

type Launch = NonNullable<AgentJournalTurnItem['launches']>[number]
type Calls = Pick<ClaudeToolOriginRegistry, 'has' | 'childOwnerRef'> & {
  /** A root background shell command (Bash with run_in_background). */
  shell: (id: string) => boolean
}

const MAX_LAUNCHES = 16
const MAX_INPUTS = 16
/** The launch record's serialized size, so a context-only revision of the row stays within its budget. */
const MAX_LAUNCH_BYTES = 3 * 1024
/** Past it the oldest is forgotten: its finish then counts as an input, so the turn names no more. */
const MAX_LAUNCHED = 64

export class ClaudeTurnLaunches {
  private sends: string[] = []
  private runs: string[] = []
  private unnamed = true
  /** Root inputs the stream showed mid-turn, and how many of those the host named as steers. */
  private inputsSeen = 0
  private steersNamed = 0
  /** A prompt was answered: from Slack or Orca, the adapter can't tell, so it's no one's input. */
  private answered = false
  /** Runs this turn launched: their finish is its own work, not an input. */
  private readonly launched = new BoundedMap<string, true>({ maxEntries: MAX_LAUNCHED })

  /** A turn opened by a send, by runs finishing (a wake-up), or by something unnamed (null). Runs
   *  that finished before it are its inputs whatever opened it. One that `replaced` a turn before
   *  that turn's end may hold its inputs too, so it records nothing. */
  begin(opener: { send?: string; finished: FinishedBefore } | null, replaced: boolean): void {
    this.sends = opener?.send ? [opener.send] : []
    this.runs = [...(opener?.finished.runs ?? [])]
    this.unnamed =
      !opener || opener.finished.unnamed || replaced || this.sends.length + this.runs.length === 0
    this.inputsSeen = 0
    this.steersNamed = 0
    this.answered = false
    this.launched.clear()
  }

  /** Someone answered the turn's question or approval. */
  promptAnswered(): void {
    this.answered = true
    this.unnamed = true
  }

  /** The host matched a send Claude read into the running turn. */
  steered(clientMessageId: string | undefined): void {
    this.steersNamed += 1
    if (clientMessageId && this.sends.length < MAX_INPUTS) {
      this.sends.push(clientMessageId)
    } else {
      this.unnamed = true
    }
  }

  /** A message was read into the turn: a wake-up then is no longer only its runs'. */
  get messaged(): boolean {
    return this.sends.length > 0 || this.inputsSeen > 0 || this.steersNamed > 0 || this.answered
  }

  /** One provider frame inside the open turn; true when it records a launch on `turn`. */
  observe(
    frame: Record<string, unknown>,
    opensTurn: boolean,
    calls: Calls,
    turn: { launches?: Launch[] },
    handed?: ClaudeHandedSends
  ): boolean {
    if (isRootInput(frame) && !opensTurn) {
      this.inputsSeen += 1
      return false
    }
    const run =
      frame.type === 'system' && taskId(frame) ? taskAliasId(frame.tool_use_id) : undefined
    // A subagent's own task reports to it; any other finish, named or not, is the root's input.
    if (frame.type === 'system' && frame.subtype === 'task_notification' && taskId(frame)) {
      return !run || calls.childOwnerRef(run) === null ? this.finished(run, turn) : false
    }
    if (frame.subtype !== 'task_started' || !run || !calls.has(run)) {
      return false
    }
    this.launched.set(run, true)
    // Only a root background shell command: an agent, a Monitor or a workflow can take input later.
    if (!calls.shell(run)) {
      return false
    }
    // Every send Orca handed Claude may have reached it by now, echoed or not: each is an input, and
    // one Orca can't name (or no list at all) leaves the launch no one's.
    const sends = [...new Set([...this.sends, ...(handed?.ids ?? [])])]
    const launches = turn.launches ?? []
    if (
      !handed ||
      handed.unnamed ||
      this.unnamed ||
      this.inputsSeen > this.steersNamed ||
      launches.length >= MAX_LAUNCHES ||
      sends.length > MAX_INPUTS
    ) {
      return false
    }
    const next = [...launches, { run, sends, runs: [...this.runs] }]
    if (JSON.stringify(next).length > MAX_LAUNCH_BYTES) {
      return false
    }
    turn.launches = next
    return true
  }

  /** A run finished into the open turn: an input, unless the turn launched it itself (then no
   *  wake-up will come for it, so its launch leaves the record). True when it changed `turn`. */
  private finished(run: string | undefined, turn: { launches?: Launch[] }): boolean {
    if (run && this.launched.delete(run)) {
      const launches = turn.launches?.filter((launch) => launch.run !== run)
      const changed = launches?.length !== turn.launches?.length
      if (launches?.length) {
        turn.launches = launches
      } else {
        delete turn.launches
      }
      return changed
    }
    if (run && this.runs.includes(run)) {
      return false
    }
    if (run && this.runs.length < MAX_INPUTS) {
      this.runs.push(run)
    } else {
      this.unnamed = true
    }
    return false
  }
}

/** A message someone sent the root agent, as the stream echoes it (text, an image, any block but a
 *  tool result), not Claude's own notice. */
export function isRootInput(frame: Record<string, unknown>): boolean {
  if (frame.type !== 'user' || frame.parent_tool_use_id || isClaudeInjectedUserMessage(frame)) {
    return false
  }
  const message = frame.message
  const content =
    message && typeof message === 'object' && 'content' in message ? message.content : undefined
  return (
    typeof content === 'string' ||
    (Array.isArray(content) &&
      content.some((block) => block && typeof block === 'object' && block.type !== 'tool_result'))
  )
}
