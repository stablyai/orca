import type {
  MailboxAgentProcess,
  MailboxForeground,
  MailboxForegroundInspection
} from '../../../terminal/wait/launched-agent-foreground'
import { PrioritySemaphore } from '../../../../../shared/concurrency/priority-semaphore'
import {
  PROCESS_START_TIME_TOLERANCE_MS,
  readProcessStartTimeMs
} from '../../../agent-session/ownership/agent-session-process-identity-probe'

type ForegroundObservation = {
  processIncarnation: string
  generation: number
  held: boolean
  screenRequired: boolean
  contradiction: number
  status?: string
  /** The admitted agent's process; while held, only that process returning releases the hold. */
  agentProcess?: MailboxAgentProcess
}

export type OrchestrationMailboxForegroundObservation = {
  observation: Readonly<Omit<ForegroundObservation, 'held' | 'screenRequired'>>
  generation: number
  contradiction: number
  process?: MailboxAgentProcess
  agentUnprovable?: boolean
  /** The held agent's process has exited, so a new agent of its kind is what the mail now awaits. */
  heldAgentGone?: boolean
}

export type OrchestrationMailboxForegroundProbe = OrchestrationMailboxForegroundObservation & {
  foreground: MailboxForeground
  agent?: MailboxForegroundInspection['agent']
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
    read: () => Promise<MailboxForeground | MailboxForegroundInspection>
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
      .then(async (result) => ({
        ...(typeof result === 'string' ? { foreground: result } : result),
        ...observation,
        ...(typeof result !== 'string' && (await this.heldAgentGone(ptyId, result.process))
          ? { heldAgentGone: true }
          : {})
      }))
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
    processIncarnation: string,
    agentUnprovable?: boolean
  ): OrchestrationMailboxForegroundObservation {
    const observation = this.foregroundObservation(ptyId, processIncarnation)
    return {
      observation,
      generation: observation.generation,
      contradiction: observation.contradiction,
      ...(agentUnprovable ? { agentUnprovable } : {})
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
      (foreground === 'shell' || foreground === 'non-shell'
        ? observation.generation !== proof.generation
        : observation.contradiction !== proof.contradiction)
    ) {
      return false
    }
    const wasHeld = observation.held
    // Why non-shell too: a known other program in front would read the pointer as its own input.
    if (foreground === 'shell' || foreground === 'non-shell') {
      // TODO(STA-16313): record the suspended agent's process here when no earlier probe named it.
      observation.held = !proof.agentUnprovable
      observation.screenRequired = true
      observation.contradiction++
    } else if (foreground === 'agent' && admitted) {
      const known = observation.agentProcess
      // Why: a same-kind agent started in place of the suspended one is not the agent the held mail awaits;
      // once the agent's process is known, a probe that cannot name it proves nothing.
      if (observation.held && known && !proof.heldAgentGone && !sameProcess(known, proof.process)) {
        return false
      }
      observation.held = false
      observation.agentProcess = proof.heldAgentGone ? proof.process : (proof.process ?? known)
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

  screenRecovery(ptyId: string): string | undefined {
    const observation = this.foregroundObservations.get(ptyId)
    return observation?.screenRequired ? observation.processIncarnation : undefined
  }

  completeDelivery(ptyId: string): void {
    const observation = this.foregroundObservations.get(ptyId)
    if (observation?.screenRequired) {
      observation.held = false
      observation.screenRequired = false
      observation.generation++
      observation.contradiction++
    }
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

  private async heldAgentGone(ptyId: string, found?: MailboxAgentProcess): Promise<boolean> {
    const known = this.foregroundObservations.get(ptyId)
    const held = known?.held ? known.agentProcess : undefined
    if (!held || sameProcess(held, found)) {
      return false
    }
    try {
      process.kill(held.pid, 0)
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ESRCH'
    }
    const startedAtMs = await readProcessStartTimeMs(held.pid)
    return startedAtMs !== null && !sameProcess(held, { pid: held.pid, startedAtMs })
  }

  private foregroundObservation(ptyId: string, processIncarnation: string): ForegroundObservation {
    let observation = this.foregroundObservations.get(ptyId)
    if (!observation || observation.processIncarnation !== processIncarnation) {
      observation = {
        processIncarnation,
        generation: 0,
        held: false,
        screenRequired: false,
        contradiction: 0
      }
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

function sameProcess(known: MailboxAgentProcess, found?: MailboxAgentProcess): boolean {
  return (
    !!found &&
    known.pid === found.pid &&
    Math.abs(known.startedAtMs - found.startedAtMs) <= PROCESS_START_TIME_TOLERANCE_MS
  )
}
