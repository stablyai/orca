import type { PtyIngressEmission } from '../../shared/pty-startup-ingress'
import { ShellCommandMarkerScanner } from '../shell-command-marker-scanner'
import type { DaemonTransientFact } from './daemon-stream-events'

export class SessionCommandMarkerIntake {
  private readonly scanner: ShellCommandMarkerScanner | null
  private rawCursor = 0
  private commandEpoch = 0

  constructor(
    enabled: boolean,
    expectedNonce: string | null,
    private readonly release: (emission: PtyIngressEmission) => void,
    private readonly onFact?: (fact: DaemonTransientFact) => void
  ) {
    this.scanner = enabled ? new ShellCommandMarkerScanner(expectedNonce) : null
  }

  accept(emission: PtyIngressEmission): void {
    if (!this.scanner || emission.transformed) {
      this.release(emission)
      this.rawCursor = emission.rawEndSeq
      return
    }
    for (const item of this.scanner.accept(emission.data)) {
      if (item.kind === 'data') {
        const rawStartSeq = this.rawCursor
        this.rawCursor += item.data.length
        this.release({
          data: item.data,
          rawStartSeq,
          rawEndSeq: this.rawCursor,
          transformed: false
        })
        continue
      }
      const rawStartSeq = this.rawCursor
      this.rawCursor += item.rawLength
      this.release({ data: '', rawStartSeq, rawEndSeq: this.rawCursor, transformed: true })
      this.commandEpoch += 1
      this.onFact?.({
        kind: 'command-started',
        agent: item.event.agent,
        trusted: item.event.trusted,
        commandEpoch: this.commandEpoch
      })
    }
  }

  drain(): void {
    const drained = this.scanner?.drain()
    if (!drained || drained.rawLength === 0) {
      return
    }
    const rawStartSeq = this.rawCursor
    this.rawCursor += drained.rawLength
    this.release({
      data: drained.data,
      rawStartSeq,
      rawEndSeq: this.rawCursor,
      transformed: drained.transformed
    })
  }
}
