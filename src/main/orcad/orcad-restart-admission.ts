import { randomUUID } from 'node:crypto'
import type { OrcadRestartAdmissionResult } from '../../shared/orcad-restart-admission'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { OrcadShutdownTrigger } from './orcad-lifecycle'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { type OrcadRestartWorkAdmission, orcadRestartWorkAdmission } from './orcad-restart-work-admission'

const RESERVATION_MS = 30_000
const DRAIN_MS = 5_000

type RestartPorts = {
  collect: (activatedAt: number) => Promise<OrcadTerminalCensus>
  drain: () => Promise<void>
  hasProviders: () => boolean
  chatWork: () => number
  shutdown: () => OrcadShutdownTrigger | null
}

const defer = (reason: string): OrcadRestartAdmissionResult => ({ status: 'defer', reason })

/** New work supersedes a reservation; only its still-current token may begin a shutdown. */
export class OrcadRestartAdmission {
  private committedToken: string | null = null
  private held: { token: string; owner: symbol; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly admission: OrcadRestartWorkAdmission, private readonly ports: RestartPorts) {}

  async reserve(activatedAt: number, force = false): Promise<OrcadRestartAdmissionResult> {
    if (!this.ports.shutdown()) {
      return defer('The server cannot verify a safe restart.')
    }
    if (this.held && !this.owns(this.held.token)) {
      clearTimeout(this.held.timer)
      this.held = null
    }
    const owner = this.admission.reserve()
    if (!owner) {
      return defer('The server is admitting work. Retry when it is idle.')
    }
    const token = randomUUID()
    const timer = setTimeout(() => this.release(token), RESERVATION_MS)
    timer.unref?.()
    this.held = { token, owner, timer }
    try {
      if (this.ports.chatWork() > 0) {
        return this.refuse(token, 'Chats still have work to finish.')
      }
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.ports.drain(),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Idle chat providers did not release in time.')), DRAIN_MS)
          })
        ])
      } finally {
        clearTimeout(deadline)
      }
      const census = await this.ports.collect(activatedAt)
      if (!this.owns(token) || this.admission.pending > 0 || this.ports.hasProviders() || census.chatWork !== 0) {
        return this.refuse(token, 'Chat work could not be proven idle.', census)
      }
      if (census.inProcessSessions !== 0 || census.liveSessions === null || (!force && census.liveSessions > 0)) {
        return this.refuse(token, 'Running terminals prevent a safe restart.', census)
      }
      return { status: 'reserved', token, census }
    } catch {
      return this.refuse(token, 'The server could not verify that its work is idle.')
    }
  }

  commit(token: string): OrcadRestartAdmissionResult {
    if (this.committedToken === token) {
      return { status: 'committed' }
    }
    if (!this.owns(token)) {
      return defer(
        this.held?.token === token
          ? 'New work superseded the restart reservation. Retry the update when chats finish.'
          : 'The restart reservation is no longer valid. Retry the update.'
      )
    }
    const shutdown = this.ports.shutdown()
    if (!shutdown || this.admission.pending > 0 || this.ports.hasProviders() || this.ports.chatWork() > 0 || !this.held || !this.admission.closeForShutdown(this.held.owner)) {
      return this.refuse(token, 'New work prevents this restart.')
    }
    // No await between the final facts and shutdown; admission stays closed until process exit.
    clearTimeout(this.held?.timer)
    this.held = null
    this.committedToken = token
    // Let the commit reply reach the transport before shutdown closes its socket.
    setImmediate(() => shutdown('update'))
    return { status: 'committed' }
  }

  release(token: string): OrcadRestartAdmissionResult {
    if (this.held?.token === token) {
      clearTimeout(this.held.timer)
      this.admission.release(this.held.owner)
      this.held = null
    }
    return { status: 'released' }
  }

  /** Older clients already decide terminal policy; only the host can protect its chats. */
  async restartLegacySlot(): Promise<void> {
    const reserved = await this.reserve(0, true)
    if (reserved.status === 'reserved' && reserved.token) {
      this.commit(reserved.token)
    }
  }

  private owns(token: string): boolean {
    return this.held?.token === token && this.admission.owns(this.held.owner)
  }

  private refuse(token: string, reason: string, census?: OrcadTerminalCensus): OrcadRestartAdmissionResult {
    this.release(token)
    return { ...defer(reason), ...(census ? { census } : {}) }
  }
}

let requestShutdown: OrcadShutdownTrigger | null = null
export function bindOrcadRestartShutdown(request: OrcadShutdownTrigger): void { requestShutdown = request }

export const orcadRestartAdmission = new OrcadRestartAdmission(orcadRestartWorkAdmission, {
  collect: async (activatedAt) => {
    const { collectOrcadTerminalCensus } = await import('./orcad-terminal-census')
    return collectOrcadTerminalCensus(activatedAt)
  },
  drain: async () => { await getStructuredAgentSessionHost()?.drainForRestart() },
  hasProviders: () => getStructuredAgentSessionHost()?.hasLoadedProviders() ?? false,
  chatWork: () => getStructuredAgentSessionHost()?.restartWorkCount() ?? 0,
  shutdown: () => requestShutdown
})
