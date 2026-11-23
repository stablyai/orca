// Who each background run the root agent launches is for, fixed at its launch: every input the turn
// had taken by then, in the order the stream shows them (the send that opened it, each send steered
// in, the runs that woke it or finished into it). A turn with an input Orca can't name records no
// more launches.
import type { AgentJournalTurnItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { taskAliasId, taskId } from '../../background-tasks/claude-background-task-frames'
import { isClaudeInjectedUserMessage } from '../journal/claude-internal-message-content'
import type { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'

type Launch = NonNullable<AgentJournalTurnItem['launches']>[number]
type Calls = Pick<ClaudeToolOriginRegistry, 'has' | 'childOwnerRef'>

const MAX_LAUNCHES = 16
const MAX_INPUTS = 16

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
  private readonly launched = new Set<string>()

  /** A turn opened: by a send, by runs finishing (a wake-up), or by something unnamed. */
  begin(opener: { send?: string; runs?: readonly string[] }): void {
    this.sends = opener.send ? [opener.send] : []
    this.runs = opener.send ? [] : [...(opener.runs ?? [])]
    this.unnamed = this.sends.length + this.runs.length === 0
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
    turn: { launches?: Launch[] }
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
    this.launched.add(run)
    const launches = turn.launches ?? []
    if (this.unnamed || this.inputsSeen > this.steersNamed || launches.length >= MAX_LAUNCHES) {
      return false
    }
    turn.launches = [...launches, { run, sends: [...this.sends], runs: [...this.runs] }]
    return true
  }

  /** A run finished into the open turn: an input, unless the turn launched it itself (then no
   *  wake-up will come for it, so its launch leaves the record). True when it changed `turn`. */
  private finished(run: string | undefined, turn: { launches?: Launch[] }): boolean {
    if (run && this.launched.has(run)) {
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
