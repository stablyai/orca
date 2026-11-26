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
  noteProviderRelayRunVerdict,
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
 * again (sends, failed attaches, retries after `unknown`).
 */
export async function providerRelayRunLiveness(
  record: ProviderRelayRunRecord,
  options: { waitMs?: number; fresh?: boolean } = {}
): Promise<ProviderRelayRunLiveness> {
  const verdict = await decide(record, options.waitMs ?? DEFAULT_WAIT_MS, options.fresh === true)
  noteProviderRelayRunVerdict(record.sessionId, verdict)
  return verdict
}

async function decide(
  record: ProviderRelayRunRecord,
  waitMs: number,
  fresh: boolean
): Promise<ProviderRelayRunLiveness> {
  const route = providerRelayRoute()
  const local = record.location.executionHostId === LOCAL_EXECUTION_HOST_ID
  const placement = currentPlacement(record)
  if (!route || !providerRelayMayKeep(record.provider, local) || placement?.kind !== 'relayed') {
    forgetListedProviderRelayChat(record.sessionId)
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
      if (!info.attached) {
        await placeKeptProviderRelay(record.sessionId, {
          channel: providerRelayChannel(client),
          info
        })
      }
      return 'kept'
    }
    forgetListedProviderRelayChat(record.sessionId)
    return 'gone'
  }
  // Its daemon start can't answer: only both processes proven gone end the run. A daemon can lose
  // its endpoint and keep its agents, and a supervised agent may outlive its daemon for a grace.
  if (await processesProvenGone(placement)) {
    forgetListedProviderRelayChat(record.sessionId)
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
  daemonProofs.set(daemon.instance, { at: Date.now(), gone })
  return gone
}

async function processesProvenGone(
  placement: Extract<AgentSessionRunPlacement, { kind: 'relayed' }>
): Promise<boolean> {
  const { daemon, agent } = placement
  // A live daemon decides alone; its agent is only probed once the daemon is proven gone.
  return (await daemonProvenGone(daemon, agent.hostId)) && provenGone(agent, true)
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
