import type { AgentSessionProcessIdentity } from '../../shared/agent-session/lifecycle/agent-session-record'
import { probeAgentSessionProcessIdentity } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readEchoedAgentSessionSpawnToken } from '../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import { providerRelayRunAwaited } from './provider-relay-launch-inventory'

/** Exit proof for a relayed run's daemon or agent: pid gone or replaced; anything else is unproven. */
export async function provenGone(identity: AgentSessionProcessIdentity, readToken: boolean) {
  const probe = await probeAgentSessionProcessIdentity({
    identity,
    deps: readToken ? { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken } : {}
  }).catch(() => null)
  return probe?.outcome === 'pid-absent' || probe?.outcome === 'identity-mismatch'
}

/**
 * Agents outliving a dead daemon are probed four at a time in arrival order, at most one probe per
 * agent queued or running, and at most 256 queued: an ask beyond that stays unproven until its next
 * retry. Each caller waits only its own deadline and then detaches. A queued probe keeps its place
 * past its callers' deadlines, but is skipped once no chat it serves awaits a verdict; a proof that
 * arrives after its callers left is kept for the next ask.
 */
const AGENT_PROBES_RUNNING = 4
const AGENT_PROBES_QUEUED = 256
const AGENT_PROOF_KEPT_MS = 5 * 60_000
type AgentProbe = {
  agent: AgentSessionProcessIdentity
  chats: Set<string>
  waiters: Set<(gone: boolean) => void>
}
let agentProbesRunning = 0
const agentProbeQueue: string[] = []
let agentProbeHead = 0
const agentProbes = new Map<string, AgentProbe>()
/** Exits proven after their callers left, in proof order; read once, expired from the front. */
const agentExits = new Map<string, number>()

function admitNextAgentProbe(): void {
  while (agentProbesRunning < AGENT_PROBES_RUNNING && agentProbeHead < agentProbeQueue.length) {
    const key = agentProbeQueue[agentProbeHead]
    agentProbeHead += 1
    const probe = agentProbes.get(key)
    if (!probe) {
      continue
    }
    if (probe.waiters.size === 0 && ![...probe.chats].some(providerRelayRunAwaited)) {
      agentProbes.delete(key)
      continue
    }
    agentProbesRunning += 1
    void runAgentProbe(key, probe)
  }
  if (agentProbeHead > 32 && agentProbeHead * 2 > agentProbeQueue.length) {
    agentProbeQueue.splice(0, agentProbeHead)
    agentProbeHead = 0
  }
}

async function runAgentProbe(key: string, probe: AgentProbe): Promise<void> {
  const gone = await provenGone(probe.agent, true)
  agentProbes.delete(key)
  agentProbesRunning -= 1
  if (gone && probe.waiters.size === 0) {
    keepAgentExit(key)
  }
  for (const waiter of probe.waiters) {
    waiter(gone)
  }
  admitNextAgentProbe()
}

function keepAgentExit(key: string): void {
  const now = Date.now()
  for (const [old, at] of agentExits) {
    if (now - at < AGENT_PROOF_KEPT_MS) {
      break
    }
    agentExits.delete(old)
  }
  agentExits.delete(key)
  agentExits.set(key, now)
}

function takeAgentExit(key: string): boolean {
  const at = agentExits.get(key)
  agentExits.delete(key)
  return at !== undefined && Date.now() - at < AGENT_PROOF_KEPT_MS
}

export function agentProvenGone(
  chatKey: string,
  agent: AgentSessionProcessIdentity,
  deadlineMs: number
): Promise<boolean> {
  const key = `${agent.hostId}:${agent.pid}:${agent.processStartTimeMs}:${agent.spawnToken}`
  if (takeAgentExit(key)) {
    return Promise.resolve(true)
  }
  let probe = agentProbes.get(key)
  if (!probe) {
    if (agentProbeQueue.length - agentProbeHead >= AGENT_PROBES_QUEUED) {
      return Promise.resolve(false)
    }
    probe = { agent, chats: new Set(), waiters: new Set() }
    agentProbes.set(key, probe)
    agentProbeQueue.push(key)
  }
  probe.chats.add(chatKey)
  const joined = probe
  return new Promise<boolean>((resolve) => {
    const waiter = (gone: boolean): void => {
      clearTimeout(timer)
      resolve(gone)
    }
    const timer = setTimeout(() => {
      joined.waiters.delete(waiter)
      resolve(false)
    }, deadlineMs)
    timer.unref?.()
    joined.waiters.add(waiter)
    admitNextAgentProbe()
  })
}
