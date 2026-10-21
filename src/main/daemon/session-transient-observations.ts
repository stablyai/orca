import { createTerminalTitleTracker } from '../../shared/terminal-output-side-effects'
import type {
  TerminalTransientCurrent,
  TerminalTransientFact,
  TerminalTransientObservation
} from '../../shared/terminal-transient-observation'

/** Physical output interpretation survives every viewing client's detach and display gap. */
export class SessionTransientObservations {
  private revision = 0
  private rawEndSeq = 0
  private current: TerminalTransientCurrent
  private readonly tracker

  constructor(publish: (observation: TerminalTransientObservation) => void, adopted = false) {
    this.current = {
      command: adopted ? 'uncertain' : 'unseen',
      commandRevision: 0,
      mode2031: 'unknown',
      modeRevision: 0
    }
    const emit = (fact: TerminalTransientFact): void => {
      if (this.revision === Number.MAX_SAFE_INTEGER) {
        return
      }
      this.revision++
      if (fact.kind === 'command-started' || fact.kind === 'command-finished') {
        this.current.command = fact.kind === 'command-started' ? 'running' : 'prompt'
        this.current.commandRevision = this.revision
      } else if (fact.kind === '2031-subscribe' || fact.kind === '2031-unsubscribe') {
        this.current.mode2031 = fact.kind === '2031-subscribe' ? 'subscribed' : 'unsubscribed'
        this.current.modeRevision = this.revision
      }
      publish({ kind: 'observation', revision: this.revision, rawEndSeq: this.rawEndSeq, fact })
    }
    this.tracker = createTerminalTitleTracker({
      onCommandStarted: () => emit({ kind: 'command-started' }),
      onCommandFinished: (exitCode) => emit({ kind: 'command-finished', exitCode }),
      onBell: () => emit({ kind: 'bell' }),
      onPrLink: (link) => emit({ kind: 'pr-link', url: link.url }),
      onMode2031Subscribe: () => emit({ kind: '2031-subscribe' }),
      onMode2031Unsubscribe: () => emit({ kind: '2031-unsubscribe' })
    })
  }

  observe(data: string, rawEndSeq: number): void {
    this.rawEndSeq = rawEndSeq
    this.tracker.handleChunk(data, { titleScanData: '' })
  }

  snapshot(): TerminalTransientObservation {
    return {
      kind: 'install',
      revision: this.revision,
      rawEndSeq: this.rawEndSeq,
      current: { ...this.current }
    }
  }

  dispose(): void {
    this.tracker.dispose()
  }
}
