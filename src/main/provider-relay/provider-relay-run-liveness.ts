import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import {
  agentSessionRunPlacement,
  type AgentSessionRunDaemon,
  type AgentSessionRunPlacement
} from '../../shared/agent-session/lifecycle/agent-session-run-placement'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session/lifecycle/agent-session-record'
import { probeAgentSessionProcessIdentity } from '../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { readEchoedAgentSessionSpawnToken } from '../runtime/agent-session/ownership/agent-session-spawn-token-readback'
import { providerRelayChannel } from './provider-relay-channel'
import {
  forgetListedProviderRelayChat,
  keptProviderRelayOutstanding,
  listProviderRelayInstance,
  beginProviderRelayRunAsk,
  noteProviderRelayRunVerdict,
  providerRelayRunAskCurrent,
  placeKeptProviderRelay,
  providerRelayMayKeep
} from './provider-relay-launch-inventory'
import { providerRelayRoute } from './provider-relay-route'

/** `kept`: its daemon start holds it. `gone`: proven ended. `unknown`: its daemon can't say yet. */
export type ProviderRelayRunLiveness = 'kept' | 'gone' | 'unknown'

export type ProviderRelayRunRecord = {
  sessionId: string
  provider: string
  location: { executionHostId: string }
  lastRunPlacement?: unknown
  /** The recorded owner (a store record's lease, or a conversation view's observation). */
  lease?: { ownerProcess: AgentSessionProcessIdentity | null }
  ownerObservation?: { ownerProcess: AgentSessionProcessIdentity | null }
}

const DEFAULT_WAIT_MS = 3_000
const CONNECT_WAIT_MS = 1_000

/**
 * Whether the chat's last run may still be running, decided only by where it ran: a run in this
 * app ended with its app; a relayed run is decided by its own daemon start, or, when that start
 * can't be reached, by its daemon and agent processes both proven gone. `fresh` asks the daemon
 * again (sends, failed attaches, retries after `unknown`). `observe` only reads the verdict: the
 * chat's recovery state (its reattach row, its unknown mark) is left to the chat's own asks.
 */
export async function providerRelayRunLiveness(
  record: ProviderRelayRunRecord,
  options: { waitMs?: number; fresh?: boolean; observe?: boolean } = {}
): Promise<ProviderRelayRunLiveness> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS
  const fresh = options.fresh === true
  if (options.observe === true) {
    return decide(record, waitMs, fresh, null)
  }
  const ask = beginProviderRelayRunAsk(record.sessionId)
  let verdict: ProviderRelayRunLiveness | null = null
  try {
    verdict = await decide(record, waitMs, fresh, ask)
    return verdict
  } finally {
    noteProviderRelayRunVerdict(record.sessionId, ask, verdict)
  }
}

async function decide(
  record: ProviderRelayRunRecord,
  waitMs: number,
  fresh: boolean,
  /** The ask's number; null observes only. */
  ask: number | null
): Promise<ProviderRelayRunLiveness> {
  const forget = (): void => {
    if (ask !== null && providerRelayRunAskCurrent(record.sessionId, ask)) {
      forgetListedProviderRelayChat(record.sessionId)
    }
  }
  const route = providerRelayRoute()
  const local = record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
  const placement = currentPlacement(record)
  if (!route || !providerRelayMayKeep(record.provider, local) || placement?.kind !== 'relayed') {
    forget()
    return 'gone'
  }
  const client = await instanceClient(route.all, placement.daemon.instance, waitMs)
  const listing = client
    ? await withTimeout(
        listProviderRelayInstance(client, placement.daemon.instance, fresh),
        waitMs,
        null
      )
    : null
  if (client && listing) {
    const info = listing.get(placement.relayId)
    if (info && keptProviderRelayOutstanding(info)) {
      if (!info.attached && ask !== null) {
        await placeKeptProviderRelay(
          record.sessionId,
          { channel: providerRelayChannel(client), info },
          ask
        )
      }
      return 'kept'
    }
    forget()
    return 'gone'
  }
  // Its daemon start can't answer: only both processes proven gone end the run. A daemon can lose
  // its endpoint and keep its agents, and a supervised agent may outlive its daemon for a grace.
  if (await processesProvenGone(placement, waitMs)) {
    forget()
    return 'gone'
  }
  return 'unknown'
}

/**
 * The placement of the run the record's owner belongs to. A recorded owner that isn't the
 * placement's agent means a build that records no placement started a later run: the placement is
 * stale and names nothing.
 */
function currentPlacement(record: ProviderRelayRunRecord): AgentSessionRunPlacement | null {
  const placement = agentSessionRunPlacement(record)
  const owner = record.lease?.ownerProcess ?? record.ownerObservation?.ownerProcess ?? null
  if (
    placement?.kind === 'relayed' &&
    owner &&
    (owner.pid !== placement.agent.pid || owner.spawnToken !== placement.agent.spawnToken)
  ) {
    return null
  }
  return placement
}

/** The connected client whose hello names this daemon start, if any answers in time. */
async function instanceClient(
  all: () => Promise<DaemonClient[]>,
  instance: string,
  waitMs: number
): Promise<DaemonClient | null> {
  const clients = await withTimeout(
    all().catch(() => []),
    waitMs,
    []
  )
  const named = (client: DaemonClient) => client.getDaemonIdentity()?.launchNonce === instance
  const found = clients.find(named)
  if (found) {
    return found
  }
  // A client not connected yet has no hello to read; give each one short connect.
  const waiting = clients.filter((client) => client.getDaemonIdentity() === null)
  await Promise.all(
    waiting.map((client) =>
      client.ensureConnectedWithin(Math.min(waitMs, CONNECT_WAIT_MS)).catch(() => {})
    )
  )
  return waiting.find(named) ?? null
}

async function provenGone(identity: AgentSessionProcessIdentity, readToken: boolean) {
  const probe = await probeAgentSessionProcessIdentity({
    identity,
    deps: readToken ? { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken } : {}
  }).catch(() => null)
  return probe?.outcome === 'pid-absent' || probe?.outcome === 'identity-mismatch'
}

/** One daemon start's proof, shared by every chat asking within 2 s; bounded by daemon starts. */
const DAEMON_PROOF_FRESH_MS = 2_000
const daemonProofs = new Map<string, { at: number; gone: Promise<boolean> }>()

function daemonProvenGone(daemon: AgentSessionRunDaemon, hostId: string): Promise<boolean> {
  const cached = daemonProofs.get(daemon.instance)
  if (cached && Date.now() - cached.at < DAEMON_PROOF_FRESH_MS) {
    return cached.gone
  }
  const gone = provenGone(
    { hostId, pid: daemon.pid, processStartTimeMs: Math.round(daemon.startedAtMs), spawnToken: '' },
    false
  )
  for (const [key, old] of daemonProofs) {
    if (Date.now() - old.at >= DAEMON_PROOF_FRESH_MS) {
      daemonProofs.delete(key)
    }
  }
  daemonProofs.set(daemon.instance, { at: Date.now(), gone })
  return gone
}

/**
 * Agents outliving a dead daemon are probed four at a time in arrival order. Each agent has at most
 * one probe queued or running, however many chats ask, so the queue holds at most the agents being
 * asked about. A probe keeps its place when its callers stop waiting: each caller waits only its
 * own deadline, and the next ask finds the probe's answer (a proof of exit is kept until it's read).
 */
const AGENT_PROBES_RUNNING = 4
const AGENT_PROOF_KEPT_MS = 5 * 60_000
let agentProbesRunning = 0
const agentProbeQueue: (() => void)[] = []
let agentProbeHead = 0
const agentProbes = new Map<string, Promise<boolean>>()
/** Exits proven after their asker stopped waiting, by agent; read once, pruned on insert. */
const agentExits = new Map<string, number>()

function admitNextAgentProbe(): void {
  while (agentProbesRunning < AGENT_PROBES_RUNNING && agentProbeHead < agentProbeQueue.length) {
    const start = agentProbeQueue[agentProbeHead]
    agentProbeHead += 1
    agentProbesRunning += 1
    start()
  }
  if (agentProbeHead > 32 && agentProbeHead * 2 > agentProbeQueue.length) {
    agentProbeQueue.splice(0, agentProbeHead)
    agentProbeHead = 0
  }
}

function agentProbe(key: string, agent: AgentSessionProcessIdentity): Promise<boolean> {
  const running = agentProbes.get(key)
  if (running) {
    return running
  }
  const probe = new Promise<void>((admit) => {
    agentProbeQueue.push(admit)
    admitNextAgentProbe()
  })
    .then(() => provenGone(agent, true))
    .then((gone) => {
      if (gone) {
        for (const [old, at] of agentExits) {
          if (Date.now() - at >= AGENT_PROOF_KEPT_MS) {
            agentExits.delete(old)
          }
        }
        agentExits.set(key, Date.now())
      }
      return gone
    })
    .finally(() => {
      agentProbes.delete(key)
      agentProbesRunning -= 1
      admitNextAgentProbe()
    })
  agentProbes.set(key, probe)
  return probe
}

async function agentProvenGone(
  agent: AgentSessionProcessIdentity,
  deadlineMs: number
): Promise<boolean> {
  const key = `${agent.hostId}:${agent.pid}:${agent.processStartTimeMs}:${agent.spawnToken}`
  if (agentExits.delete(key)) {
    return true
  }
  const gone = await withTimeout(agentProbe(key, agent), deadlineMs, false)
  // The answer reached this caller: it isn't kept for a later one.
  if (gone) {
    agentExits.delete(key)
  }
  return gone
}

async function processesProvenGone(
  placement: Extract<AgentSessionRunPlacement, { kind: 'relayed' }>,
  deadlineMs: number
): Promise<boolean> {
  const { daemon, agent } = placement
  // A live daemon decides alone; its agent is only probed once the daemon is proven gone.
  return (await daemonProvenGone(daemon, agent.hostId)) && agentProvenGone(agent, deadlineMs)
}

/**
 * The host's answer for a chat about to start: its last run's liveness, asked fresh; a gone run the
 * host was holding settles before the gate returns. Without a host, `fallback` answers.
 */
let runGate: ((chatKey: string) => Promise<ProviderRelayRunLiveness>) | null = null

export function installProviderRelayRunGate(gate: typeof runGate): void {
  runGate = gate
}

export async function providerRelayRunGate(
  chatKey: string,
  fallback: ProviderRelayRunLiveness
): Promise<ProviderRelayRunLiveness> {
  return runGate ? runGate(chatKey).catch(() => 'unknown' as const) : fallback
}
