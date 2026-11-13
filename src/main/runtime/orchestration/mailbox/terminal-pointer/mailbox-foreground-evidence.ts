import type { MailboxForeground } from '../../../terminal/wait/launched-agent-foreground'
import { PrioritySemaphore } from '../../../../../shared/priority-semaphore'

type ForegroundObservation = {
  processIncarnation: string
  generation: number
  held: boolean
  contradiction: number
  status?: string
}

export type OrchestrationMailboxForegroundObservation = {
  observation: Readonly<Omit<ForegroundObservation, 'held'>>
  generation: number
  contradiction: number
}

export type OrchestrationMailboxForegroundProbe = OrchestrationMailboxForegroundObservation & {
  foreground: MailboxForeground
}

export class MailboxForegroundEvidence {
  constructor(private readonly onRecovery: (ptyId: string) => void = () => {}) {}

  private readonly foregroundInspections = new PrioritySemaphore(4)
  private readonly foregroundObservations = new Map<string, ForegroundObservation>()
  private readonly foregroundProbes = new Map<
    string,
    Promise<OrchestrationMailboxForegroundProbe>
  >()

  probeForeground(
    ptyId: string,
    processIncarnation: string,
    read: () => Promise<MailboxForeground>
  ): Promise<OrchestrationMailboxForegroundProbe> {
    const observation = this.captureForegroundObservation(ptyId, processIncarnation)
    const pending = this.foregroundProbes.get(ptyId)
    if (pending) {
      return pending
    }
    const probe = Promise.resolve()
      .then(async () => {
        const release = await this.foregroundInspections.acquire(0)
        try {
          return this.foregroundObservations.get(ptyId) === observation.observation
            ? await read()
            : ('unknown' as const)
        } finally {
          release()
        }
      })
      .catch(() => 'unknown' as const)
      .then((foreground) => ({ foreground, ...observation }))
      .finally(() => {
        if (this.foregroundProbes.get(ptyId) === probe) {
          this.foregroundProbes.delete(ptyId)
        }
      })
    this.foregroundProbes.set(ptyId, probe)
    return probe
  }

  captureForegroundObservation(
    ptyId: string,
    processIncarnation: string
  ): OrchestrationMailboxForegroundObservation {
    const observation = this.foregroundObservation(ptyId, processIncarnation)
    return {
      observation,
      generation: observation.generation,
      contradiction: observation.contradiction
    }
  }

  applyForeground(
    ptyId: string,
    proof: OrchestrationMailboxForegroundObservation | undefined,
    foreground: MailboxForeground = 'shell',
    admitted = false
  ): boolean {
    const observation = this.foregroundObservations.get(ptyId)
    if (
      !proof ||
      !observation ||
      observation !== proof.observation ||
      (foreground === 'shell'
        ? observation.generation !== proof.generation
        : observation.contradiction !== proof.contradiction)
    ) {
      return false
    }
    const wasHeld = observation.held
    if (foreground === 'shell') {
      observation.held = true
      observation.contradiction++
    } else if (foreground === 'agent' && admitted) {
      observation.held = false
    }
    if (wasHeld && !observation.held) {
      this.onRecovery(ptyId)
    }
    return true
  }

  foregroundHold(ptyId: string): string | undefined {
    const observation = this.foregroundObservations.get(ptyId)
    return observation?.held ? observation.processIncarnation : undefined
  }

  observeTerminal(ptyId: string, status?: string): boolean {
    const observation = this.foregroundObservations.get(ptyId)
    if (!observation) {
      return false
    }
    observation.generation++
    if (status === 'done') {
      status = 'idle'
    }
    const changed = status !== undefined && observation.status !== status
    if (status !== undefined) {
      observation.status = status
    }
    return observation.held && changed
  }

  private foregroundObservation(ptyId: string, processIncarnation: string): ForegroundObservation {
    let observation = this.foregroundObservations.get(ptyId)
    if (!observation || observation.processIncarnation !== processIncarnation) {
      observation = { processIncarnation, generation: 0, held: false, contradiction: 0 }
      this.foregroundObservations.set(ptyId, observation)
    }
    return observation
  }

  hasForegroundProbe(ptyId: string): boolean {
    return this.foregroundProbes.has(ptyId)
  }

  retirePty(ptyId: string): void {
    this.foregroundObservations.delete(ptyId)
  }
}
