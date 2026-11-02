import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../shared/generated-agent-input-readiness'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../shared/terminal-input'
import { InvalidArgumentError } from '../core'

type Part = { id: string; index: number; final: boolean }
type Staged = { text: string; next: number; deadline: number; timer: ReturnType<typeof setTimeout> }

const MAX_STAGED_OPERATIONS = 32

/** Text too large for one remote request arrives in ordered parts. Staging is in memory only and
 *  dies with the operation's deadline, so an abandoned upload cannot outlive the budget. */
export class GeneratedInputParts {
  private readonly staged = new Map<string, Staged>()

  accept(
    caller: string,
    params: { text: string; timeoutMs?: number; part?: Part }
  ): { kind: 'pending' } | { kind: 'complete'; text: string; deadline: number } {
    const budget = Math.min(params.timeoutMs ?? Infinity, GENERATED_AGENT_INPUT_TIMEOUT_MS)
    if (!params.part) {
      return { kind: 'complete', text: params.text, deadline: Date.now() + budget }
    }
    const key = `${caller}\u0000${params.part.id}`
    let entry = this.staged.get(key)
    if (!entry && params.part.index === 0) {
      if (this.staged.size >= MAX_STAGED_OPERATIONS) {
        throw new InvalidArgumentError('Too many generated input uploads in flight')
      }
      const deadline = Date.now() + budget
      entry = {
        text: '',
        next: 0,
        deadline,
        timer: setTimeout(() => this.staged.delete(key), Math.max(0, budget))
      }
      entry.timer.unref?.()
      this.staged.set(key, entry)
    }
    if (!entry || entry.next !== params.part.index) {
      this.drop(key)
      throw new InvalidArgumentError('Generated input part out of order')
    }
    entry.text += params.text
    entry.next += 1
    if (entry.text.length > TERMINAL_INPUT_MAX_BYTES) {
      this.drop(key)
      throw new InvalidArgumentError('Generated input is too large')
    }
    if (!params.part.final) {
      return { kind: 'pending' }
    }
    this.drop(key)
    return { kind: 'complete', text: entry.text, deadline: entry.deadline }
  }

  private drop(key: string): void {
    const entry = this.staged.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.staged.delete(key)
    }
  }
}
