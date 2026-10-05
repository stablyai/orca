import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import { isSameAgentProcess, type AgentProcessIdentity } from '../../shared/agent-process-presence'
import { AgentExitRunRegistry, readRecognizedForegroundAgent } from './agent-exit-run-registry'
import { bootstrapAgentProcessIdentity } from './agent-process-identity-bootstrap'

// Why three tries (now, 1 s, 5 s): a just-typed launch needs a moment to exec; then stop.
const AGENT_IDENTITY_DISCOVERY_DELAYS_MS = [0, 1_000, 5_000] as const
// Why a few: recognized agent activity after a settled round buys one more look, not a poll.
const AGENT_IDENTITY_EVIDENCE_LOOKS = 3

type AgentIdentityDiscovery = {
  key: string
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  evidenceLooks: number
}

export type AgentExitPtyRecord = {
  incarnationId: string | null
  connected: boolean
  connectionId: string | null
  isWsl: boolean | null
}

/**
 * Learns the exact process of an agent run no hook identified (Codex, hooks off): one fenced,
 * incarnation-matched foreground capture that recognizes the agent, converted to the canonical
 * PID/start identity only when both readings name the same process. At most three captures per
 * run (one more round once its exit is proven, and a few single looks on recognized agent
 * activity); never a periodic table scan.
 */
export class OrcaRuntimeWithAgentIdentityDiscovery extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  protected readonly agentExitRuns = new AgentExitRunRegistry()
  private readonly agentIdentityDiscoveryByPtyId = new Map<string, AgentIdentityDiscovery>()
  // Why declared: defined later in the runtime chain, which this split class cannot import.
  declare protected getPtyRecordForPaneKey: (paneKey: string) => { ptyId: string } | null

  /** Overridden by the proof layer: an identified run may now be watched. */
  protected scheduleAgentPresenceTick(_delayMs?: number): void {}

  onPtyExit(...args: Parameters<OrcaRuntimeWithSerializeAgentPromptSubmission['onPtyExit']>) {
    const result = super.onPtyExit(...args)
    this.forgetAgentExitRun(args[0])
    return result
  }

  protected forgetAgentExitRun(ptyId: string): void {
    this.agentExitRuns.forget(ptyId)
    const discovery = this.agentIdentityDiscoveryByPtyId.get(ptyId)
    if (discovery?.timer) {
      clearTimeout(discovery.timer)
    }
    this.agentIdentityDiscoveryByPtyId.delete(ptyId)
  }

  protected bootstrapAgentIdentity(captured: {
    pid: number
    startTime: string
  }): Promise<AgentProcessIdentity | null> {
    return bootstrapAgentProcessIdentity(captured)
  }

  protected readAgentExitPty(ptyId: string): AgentExitPtyRecord | null {
    const record = this.ptysById.get(ptyId)
    return record?.connected ? record : null
  }

  /** This host can read the agent's PID namespace itself (local daemon or in-process, POSIX). */
  protected canProbeAgentProcessLocally(record: AgentExitPtyRecord): boolean {
    return record.connectionId === null && record.isWsl !== true && process.platform !== 'win32'
  }

  /**
   * One round of looks per run, and one more each once its process is gone and once its exit is
   * proven; `evidence` (recognized agent activity) buys a single extra look after a round settled,
   * a few times per round.
   */
  protected startAgentIdentityDiscovery(ptyId: string, options: { evidence?: boolean } = {}): void {
    const record = this.readAgentExitPty(ptyId)
    if (
      !record ||
      !this.ptyController?.inspectProcess ||
      !this.canProbeAgentProcessLocally(record)
    ) {
      return
    }
    const run = this.agentExitRuns.current(ptyId)
    const phase = run?.exitProven ? 'ended' : run?.processGone ? 'gone' : ''
    const key = `${record.incarnationId ?? ''}|${run?.runId ?? 0}|${phase}`
    const existing = this.agentIdentityDiscoveryByPtyId.get(ptyId)
    if (existing?.key === key) {
      if (
        options.evidence &&
        !existing.timer &&
        !existing.inFlight &&
        existing.evidenceLooks < AGENT_IDENTITY_EVIDENCE_LOOKS
      ) {
        existing.evidenceLooks += 1
        this.runAgentIdentityLook(ptyId, record.incarnationId, existing, null)
      }
      return
    }
    if (existing?.timer) {
      clearTimeout(existing.timer)
    }
    const state: AgentIdentityDiscovery = { key, timer: null, inFlight: false, evidenceLooks: 0 }
    this.agentIdentityDiscoveryByPtyId.set(ptyId, state)
    this.runAgentIdentityLook(ptyId, record.incarnationId, state, 0)
  }

  /** One capture; `index` continues the round's retries, null is a single extra look. */
  private runAgentIdentityLook(
    ptyId: string,
    incarnationId: string | null,
    state: AgentIdentityDiscovery,
    index: number | null
  ): void {
    state.timer = null
    state.inFlight = true
    void this.discoverAgentIdentity(ptyId, incarnationId)
      // Why: a throw must neither strand the round nor reject unhandled (orcad has no handler).
      .catch((error: unknown) => {
        console.warn('[native-chat] agent identity look failed', error)
        return false
      })
      .then((done) => {
        state.inFlight = false
        const delay = index === null ? undefined : AGENT_IDENTITY_DISCOVERY_DELAYS_MS[index + 1]
        if (
          !done &&
          index !== null &&
          delay !== undefined &&
          this.agentIdentityDiscoveryByPtyId.get(ptyId) === state
        ) {
          state.timer = setTimeout(
            () => this.runAgentIdentityLook(ptyId, incarnationId, state, index + 1),
            delay
          )
          state.timer.unref?.()
        }
      })
  }

  /** True when discovery is settled (found, or nothing more to learn for this incarnation). */
  private async discoverAgentIdentity(
    ptyId: string,
    incarnationId: string | null
  ): Promise<boolean> {
    const inspect = this.ptyController?.inspectProcess
    const stillThisPty = (): boolean =>
      this.readAgentExitPty(ptyId)?.incarnationId === incarnationId
    if (!inspect || !stillThisPty()) {
      return true
    }
    const inspection = await inspect
      .call(
        this.ptyController,
        ptyId,
        incarnationId ? { expectedIncarnationId: incarnationId } : {}
      )
      .catch(() => null)
    const captured = readRecognizedForegroundAgent(inspection, incarnationId)
    if (!captured || !stillThisPty()) {
      return !stillThisPty()
    }
    const identity = await this.bootstrapAgentIdentity(captured)
    if (!identity || !stillThisPty()) {
      return !stillThisPty()
    }
    const run = this.agentExitRuns.current(ptyId)
    if (
      run &&
      !run.identity &&
      !run.endHandled &&
      (run.agent ?? captured.agent) === captured.agent
    ) {
      run.identity = identity
      run.agent = captured.agent
    } else if (!run?.identity || !isSameAgentProcess(run.identity, identity)) {
      this.agentExitRuns.begin(ptyId, {
        incarnationId,
        agent: captured.agent,
        identity,
        source: 'foreground'
      })
    }
    this.scheduleAgentPresenceTick()
    return true
  }
}
