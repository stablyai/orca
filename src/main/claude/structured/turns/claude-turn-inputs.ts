// What a turn took in, read from the provider's frames: the runs whose finish woke it (wakes) and
// whose each background launch is for (launches), with the root agent's calls to tell launches by.
import { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'
import type { ClaudeCurrentTurn } from './claude-turn-lifecycle-item'
import { ClaudeTurnLaunches, isRootInput } from './claude-turn-launches'
import { ClaudeTurnWakes } from './claude-turn-wakes'

export class ClaudeTurnInputs {
  /** Which calls are the root agent's and which a subagent's. */
  readonly toolOrigins = new ClaudeToolOriginRegistry()
  private readonly wakes = new ClaudeTurnWakes()
  private readonly launches = new ClaudeTurnLaunches()

  /** The turn about to open, naming the runs that woke it when Claude opened it, not a send. */
  opening(turn: ClaudeCurrentTurn, send: string | undefined): ClaudeCurrentTurn {
    return { ...turn, ...this.wakes.take(!send), ...(send ? { openedBy: send } : {}) }
  }

  /** A turn opened (a command turn names nothing): what it took in starts from its opener. */
  begin(turn: ClaudeCurrentTurn | null): void {
    this.wakes.take(false)
    this.launches.begin(turn ? { send: turn.openedBy, runs: turn.wokenBy } : {})
  }

  /** One provider frame before it opens or joins a turn; true when it changed `turn`'s row. */
  observe(frame: Record<string, unknown>, opensTurn: boolean, turn: ClaudeCurrentTurn | null) {
    if (!turn && !opensTurn && isRootInput(frame)) {
      this.wakes.messaged()
    }
    const named = this.wakes.observe(frame, turn)
    const launched = !!turn && this.launches.observe(frame, opensTurn, this.toolOrigins, turn)
    return !!turn && (named || launched || this.unwoken(turn))
  }

  /** The host matched a send Claude read into the running turn; true when it changed its row. */
  steered(clientMessageId: string | undefined, turn: ClaudeCurrentTurn | null): boolean {
    this.launches.steered(clientMessageId)
    return !!turn && this.unwoken(turn)
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
