import type { AgentSessionProcessIdentity } from '../../shared/agent-session/lifecycle/agent-session-record'
import { probeAgentSessionProcessIdentity } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readEchoedAgentSessionSpawnToken } from '../runtime/agent-session/ownership/agent-session-spawn-token-readback'

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
 * agent. At most 256 wait in the queue; past that a probe waits in the overflow, which moves into
 * the queue first as room frees, so every awaited run is reached however many there are. A
 * chat's interest and its waiters leave the moment its run is fenced off (close, deletion, new
 * run) or decided; a probe nobody waits on and no run needs leaves its queue at once. Each
 * caller waits only its own deadline, then detaches. A proof that lands with no one waiting is kept
 * for the next ask.
 */
const AGENT_PROBES_RUNNING = 4
const AGENT_PROBES_QUEUED = 256
const AGENT_PROOF_KEPT_MS = 5 * 60_000
type AgentProbe = {
  key: string
  agent: AgentSessionProcessIdentity
  state: 'overflow' | 'queued' | 'running' | 'dropped'
  /** Chats whose current run needs this agent's answer. */
  chats: Set<string>
  /** Each caller still waiting, with the chat it asks for (null: an observe-only ask). */
  waiters: Map<(gone: boolean) => void, string | null>
}
let agentProbesRunning = 0
/** Probes queued or running, by agent. The queue (at most 256) and the overflow behind it keep
 * arrival order; a probe leaves either the moment it's dropped, so neither holds dead entries. */
const agentProbes = new Map<string, AgentProbe>()
const queue = new Map<string, AgentProbe>()
const overflow = new Map<string, AgentProbe>()
/** Which probes each chat's run is interested in, so a fence reaches them at once. */
const probesByChat = new Map<string, Set<string>>()
/** Exits proven after their callers left, in proof order; read once, expired from the front. */
const agentExits = new Map<string, number>()

/** A waiting probe nobody waits on and no run needs leaves at once, wherever it waits. */
function dropIfUnneeded(probe: AgentProbe): void {
  if (probe.waiters.size > 0 || probe.chats.size > 0) {
    return
  }
  if (probe.state === 'overflow') {
    overflow.delete(probe.key)
  } else if (probe.state === 'queued') {
    queue.delete(probe.key)
    agentProbes.delete(probe.key)
  } else {
    return
  }
  probe.state = 'dropped'
}

function refillAgentProbeQueue(): void {
  for (const [key, probe] of overflow) {
    if (queue.size >= AGENT_PROBES_QUEUED) {
      return
    }
    overflow.delete(key)
    probe.state = 'queued'
    queue.set(key, probe)
    agentProbes.set(key, probe)
  }
}

function admitNextAgentProbe(): void {
  refillAgentProbeQueue()
  while (agentProbesRunning < AGENT_PROBES_RUNNING) {
    const next = queue.values().next()
    if (next.done) {
      return
    }
    const probe = next.value
    queue.delete(probe.key)
    probe.state = 'running'
    agentProbesRunning += 1
    void runAgentProbe(probe)
    refillAgentProbeQueue()
  }
}

async function runAgentProbe(probe: AgentProbe): Promise<void> {
  const gone = await provenGone(probe.agent, true)
  agentProbes.delete(probe.key)
  probe.state = 'dropped'
  agentProbesRunning -= 1
  for (const chatKey of probe.chats) {
    unindex(chatKey, probe.key)
  }
  if (gone && probe.waiters.size === 0 && probe.chats.size > 0) {
    keepAgentExit(probe.key)
  }
  for (const waiter of probe.waiters.keys()) {
    waiter(gone)
  }
  admitNextAgentProbe()
}

function unindex(chatKey: string, key: string): void {
  const keys = probesByChat.get(chatKey)
  keys?.delete(key)
  if (keys?.size === 0) {
    probesByChat.delete(chatKey)
  }
}

/** The chat's run was fenced off or decided: it needs no probe, and its callers stop waiting. */
export function cancelProviderRelayExitProbes(chatKey: string): void {
  const keys = probesByChat.get(chatKey)
  if (!keys) {
    return
  }
  probesByChat.delete(chatKey)
  for (const key of keys) {
    const probe = agentProbes.get(key) ?? overflow.get(key)
    if (!probe) {
      continue
    }
    probe.chats.delete(chatKey)
    for (const [waiter, asker] of probe.waiters) {
      if (asker === chatKey) {
        probe.waiters.delete(waiter)
        waiter(false)
      }
    }
    dropIfUnneeded(probe)
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

/**
 * `asker`: the run asking and whether its ask is still current, checked right before it registers
 * (null for an observe-only ask, which waits but holds no interest).
 */
export function agentProvenGone(
  asker: { chatKey: string; current: () => boolean } | null,
  agent: AgentSessionProcessIdentity,
  deadlineMs: number
): Promise<boolean> {
  const key = `${agent.hostId}:${agent.pid}:${agent.processStartTimeMs}:${agent.spawnToken}`
  if (takeAgentExit(key)) {
    return Promise.resolve(true)
  }
  if (asker && !asker.current()) {
    return Promise.resolve(false)
  }
  let probe = agentProbes.get(key) ?? overflow.get(key)
  if (!probe) {
    probe = { key, agent, state: 'overflow', chats: new Set(), waiters: new Map() }
    overflow.set(key, probe)
  }
  const chatKey = asker?.chatKey ?? null
  if (chatKey !== null) {
    probe.chats.add(chatKey)
    const keys = probesByChat.get(chatKey) ?? new Set<string>()
    keys.add(key)
    probesByChat.set(chatKey, keys)
  }
  const joined = probe
  return new Promise<boolean>((resolve) => {
    const waiter = (gone: boolean): void => {
      clearTimeout(timer)
      resolve(gone)
    }
    const timer = setTimeout(() => {
      joined.waiters.delete(waiter)
      dropIfUnneeded(joined)
      resolve(false)
    }, deadlineMs)
    timer.unref?.()
    joined.waiters.set(waiter, chatKey)
    admitNextAgentProbe()
  })
}
