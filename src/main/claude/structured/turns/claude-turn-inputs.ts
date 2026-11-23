// What a turn took in, read from the provider's frames: the runs whose finish woke it (wakes) and
// whose each background launch is for (launches), with the root agent's calls to tell launches by.
import { BoundedMap } from '../../../../shared/collections/bounded-map'
import { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'
import type { ClaudeCurrentTurn } from './claude-turn-lifecycle-item'
import { ClaudeTurnLaunches, isRootInput } from './claude-turn-launches'
import { ClaudeTurnWakes, type FinishedBefore } from './claude-turn-wakes'
import type { ClaudeHandedSends } from '../claude-structured-session-state'

export class ClaudeTurnInputs {
  /** Which calls are the root agent's and which a subagent's. */
  readonly toolOrigins = new ClaudeToolOriginRegistry()
  private readonly wakes = new ClaudeTurnWakes()
  private readonly launches = new ClaudeTurnLaunches()
  /** The open turn's root background shell commands (Bash with run_in_background): the only work
   *  whose launch can be a conversation's, since nothing reaches it once it runs. */
  private readonly shells = new BoundedMap<string, true>({ maxEntries: 64 })

  /** What finished before the turn being opened, taken as it was named. */
  private finishedBefore: FinishedBefore | undefined

  /** `republish` rewrites an open turn's row this changed outside a frame. */
  constructor(private readonly republish: (turn: ClaudeCurrentTurn) => void) {}

  /** The turn about to open, naming the runs that woke it when Claude opened it, not a send. */
  opening(turn: ClaudeCurrentTurn, send: string | undefined): ClaudeCurrentTurn {
    const { wokenBy, finished } = this.wakes.take(!send)
    this.finishedBefore = finished
    return { ...turn, ...(wokenBy ? { wokenBy } : {}), ...(send ? { openedBy: send } : {}) }
  }

  /** A turn opened (a command turn names nothing): what it took in starts from its opener and every
   *  run that finished before it; a turn it replaced before its end passes on its own inputs. */
  begin(turn: ClaudeCurrentTurn | null, replaced: boolean): void {
    const finished = this.finishedBefore ?? this.wakes.take(false).finished
    this.finishedBefore = undefined
    this.shells.clear()
    this.launches.begin(turn ? { send: turn.openedBy, finished } : null, replaced)
  }

  /** One provider frame before it opens or joins a turn; true when it changed `turn`'s row. */
  observe(
    event: {
      message: Record<string, unknown>
      startsTurn?: true
      handedSends?: ClaudeHandedSends
      handedPending?: true
    },
    turn: ClaudeCurrentTurn | null
  ) {
    const { message: frame, handedSends: handed } = event
    const opensTurn = !!event.startsTurn
    // A send Orca handed Claude may reach it with no echo yet, or never: no wake-up is only its runs'.
    if (event.handedPending) {
      if (turn) {
        this.launches.handedDuring()
      } else {
        this.wakes.messaged()
      }
    }
    if (!turn && !opensTurn && isRootInput(frame)) {
      this.wakes.messaged()
    }
    const named = this.wakes.observe(frame, turn, this.toolOrigins)
    const calls = {
      has: (id: string) => this.toolOrigins.has(id),
      shell: (id: string) => this.shells.has(id),
      childOwnerRef: (id: string) => this.toolOrigins.childOwnerRef(id)
    }
    const launched = !!turn && this.launches.observe(frame, opensTurn, calls, turn, handed)
    return !!turn && (named || launched || this.unwoken(turn))
  }

  /** The host matched a send Claude read into the running turn. */
  steered(clientMessageId: string | undefined, turn: ClaudeCurrentTurn | null): void {
    this.launches.steered(clientMessageId)
    if (turn && this.unwoken(turn)) {
      this.republish(turn)
    }
  }

  /** A root call the agent made in the open turn. */
  rootCall(tool: { id: string; name: string; input: unknown }): void {
    const input = tool.input
    if (
      tool.name === 'Bash' &&
      input &&
      typeof input === 'object' &&
      'run_in_background' in input &&
      input.run_in_background === true
    ) {
      this.shells.set(tool.id, true)
    }
  }

  /** Someone answered a question or approval: between turns, the next wake-up names nothing. */
  promptAnswered(turn: ClaudeCurrentTurn | null): void {
    if (!turn) {
      this.wakes.messaged()
    }
    this.launches.promptAnswered()
    if (turn && this.unwoken(turn)) {
      this.republish(turn)
    }
  }

  /** A message read into a wake-up: it names no runs from then on. */
  private unwoken(turn: ClaudeCurrentTurn): boolean {
    if (!turn.wokenBy || !this.launches.messaged) {
      return false
    }
    delete turn.wokenBy
    return true
  }
}
