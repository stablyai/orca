import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../../../../daemon/transport/client/daemon-client'
import { DaemonClientListeners } from '../../../../daemon/transport/client/daemon-client-listener-registry'
import type { ProviderRelayInfo } from '../../../../daemon/protocol/daemon-provider-relay-protocol'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { readProcessStartTimeMs } from '../../../../runtime/agent-session/ownership/agent-session-process-identity-probe'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

// Only a run's placement and its own daemon start decide whether its agent may still run: a held
// approval survives any late or partial listing, and nothing but that start's word (or both its
// daemon and agent proven gone) ever settles it.

const SESSION = 'chat-with-held-approval'
const INSTANCE = 'daemon-start-a'

const relay = (relayId: string, exit: ProviderRelayInfo['exit'] = null): ProviderRelayInfo => ({
  relayId,
  chatKey: SESSION,
  agent: 'codex-test',
  pid: process.pid,
  spawnedAtMs: 1,
  attached: false,
  exit,
  nextSeq: 20,
  ackedSeq: 18,
  pendingCount: 1
})

/**
 * A daemon start whose listing answers what `relays()` returns; null never answers, and 'busy'
 * refuses (an unanswered listing as its timeout ends it).
 */
function daemon(
  instance: string,
  relays: () => ProviderRelayInfo[] | null | 'busy',
  requests: string[] = []
) {
  const client = {
    getDaemonIdentity: () => ({
      providerRelay: true,
      pid: 1,
      startedAtMs: 1,
      launchNonce: instance
    }),
    ensureConnectedWithin: async () => {},
    onEvent: () => () => {},
    onDisconnected: () => () => {},
    connectedListeners: new DaemonClientListeners<() => void>(),
    request: (type: string) => {
      requests.push(type)
      if (type !== 'relayList') {
        return Promise.resolve({})
      }
      const listed = relays()
      if (listed === 'busy') {
        return Promise.reject(new Error('relayList timed out'))
      }
      return listed
        ? Promise.resolve({ relays: listed, daemonInstance: instance })
        : new Promise(() => {})
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the liveness reads only these members
  return client as unknown as DaemonClient
}

async function fresh(clients: DaemonClient[]) {
  vi.resetModules()
  const relays = await import('../../../../provider-relay/app-provider-relays')
  relays.registerReattachableProviderRelayAgent('codex-test', { provider: 'codex' })
  relays.installProviderRelayRoute({
    current: async () => clients[0] ?? null,
    all: async () => clients,
    appVersion: 'test',
    idleStopMs: () => null
  })
  return relays
}

const identity = (pid: number) => ({
  hostId: LOCAL_EXECUTION_HOST_ID,
  pid,
  processStartTimeMs: null,
  spawnToken: 'kept-agent-token'
})

const relayed = (daemonPid: number, agentPid: number, instance = INSTANCE) => ({
  fence: 3,
  kind: 'relayed' as const,
  relayId: 'r-1',
  daemon: { instance, pid: daemonPid, startedAtMs: 1 },
  agent: identity(agentPid)
})

const chat = (lastRunPlacement?: unknown) => ({
  sessionId: SESSION,
  provider: 'codex',
  location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
  ...(lastRunPlacement ? { lastRunPlacement } : {})
})

/** A running agent that carries its spawn token, as a relayed agent does. */
function liveAgent() {
  const agent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], {
    env: { ...process.env, [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: 'kept-agent-token' }
  })
  if (agent.pid === undefined) {
    throw new Error('no child pid')
  }
  return { pid: agent.pid, agent }
}

function exitedPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '0']).pid
  if (pid === undefined) {
    throw new Error('no child pid')
  }
  return pid
}

beforeEach(() => {
  vi.restoreAllMocks()
})

it.skipIf(process.platform === 'win32')(
  "a relayed run is kept or gone by its own daemon start's listing, never another daemon's",
  async () => {
    let listing: ProviderRelayInfo[] = [relay('r-1')]
    // Another daemon start lists an older relay for the same chat; it must never decide or reattach.
    const other = daemon('daemon-start-b', () => [relay('r-old')])
    const relays = await fresh([other, daemon(INSTANCE, () => listing)])
    const record = chat(relayed(1, 1))
    expect(await relays.providerRelayRunLiveness(record)).toBe('kept')
    expect(relays.keptRunningProviderRelayPid(SESSION)).toBe(process.pid)
    listing = [relay('r-1', { code: 0, signal: null })]
    expect(await relays.providerRelayRunLiveness(record, { fresh: true })).toBe('gone')
    expect(relays.keptRunningProviderRelayPid(SESSION)).toBeNull()
  }
)

it.skipIf(process.platform === 'win32')(
  'an observe-only ask reads the listing without ending any relay or recording anything',
  async () => {
    // Another build's agent, which this build can't reattach, sits beside the chat's kept relay.
    const requests: string[] = []
    const newer = { ...relay('r-newer'), chatKey: 'other-chat', agent: 'agent-of-a-newer-build' }
    const relays = await fresh([daemon(INSTANCE, () => [relay('r-1'), newer], requests)])
    const record = chat(relayed(1, 1))
    expect(await relays.providerRelayRunLiveness(record, { observe: true })).toBe('kept')
    expect(requests.filter((type) => type !== 'relayList')).toEqual([])
    expect(relays.keptRunningProviderRelayPid(SESSION)).toBeNull()
    expect(relays.providerRelayRunUnknown(SESSION)).toBe(false)
    // The chat's own ask acts on the same listing once: it ends the relay it can't reattach.
    expect(await relays.providerRelayRunLiveness(record)).toBe('kept')
    expect(requests.filter((type) => type !== 'relayList')).toEqual(['relayClose'])
    expect(relays.keptRunningProviderRelayPid(SESSION)).toBe(process.pid)
  }
)

it.skipIf(process.platform === 'win32')(
  'a run that started in the app, or has no placement, is gone without asking any daemon',
  async () => {
    // This daemon never answers: a direct run must not wait on it (the test's timeout would).
    const relays = await fresh([daemon(INSTANCE, () => null)])
    expect(await relays.providerRelayRunLiveness(chat({ fence: 3, kind: 'direct' }))).toBe('gone')
    expect(await relays.providerRelayRunLiveness(chat())).toBe('gone')
    // A malformed placement reads as none, never as kept.
    expect(await relays.providerRelayRunLiveness(chat({ fence: 3, kind: 'relayed' }))).toBe('gone')
  }
)

it.skipIf(process.platform === 'win32')(
  'an unanswered listing is unknown, and a later ask hears the answer instead of a cached timeout',
  async () => {
    let answers = false
    const relays = await fresh([daemon(INSTANCE, () => (answers ? [relay('r-1')] : 'busy'))])
    // Its agent still runs, so a refused listing can't end the run.
    const { pid, agent } = liveAgent()
    const record = chat(relayed(process.pid, pid))
    expect(await relays.providerRelayRunLiveness(record)).toBe('unknown')
    expect(relays.providerRelayKeptFromLastRun(SESSION)).toBe(true)
    answers = true
    expect(await relays.providerRelayRunLiveness(record, { fresh: true })).toBe('kept')
    agent.kill('SIGKILL')
  }
)

it.skipIf(process.platform !== 'linux')(
  'concurrent asks for one kept agent never lose the spawn token it carries',
  async () => {
    const { pid, agent } = liveAgent()
    const relays = await fresh([daemon(INSTANCE, () => [{ ...relay('r-1'), pid }])])
    const record = chat(relayed(process.pid, pid))
    // One ask is still reading the token back when the other answers kept.
    expect(
      await Promise.all([
        relays.providerRelayRunLiveness(record),
        relays.providerRelayRunLiveness(record, { fresh: true })
      ])
    ).toEqual(['kept', 'kept'])
    expect(relays.keptProviderRelaySpawnToken(SESSION)).toBe('kept-agent-token')
    expect(await relays.providerRelayRunLiveness(record, { fresh: true })).toBe('kept')
    expect(relays.keptProviderRelaySpawnToken(SESSION)).toBe('kept-agent-token')
    agent.kill('SIGKILL')
  }
)

it.skipIf(process.platform === 'win32')(
  'with its daemon start unreachable, a run is gone only once its daemon and agent are both proven gone',
  async () => {
    // No client speaks for this start: its endpoint may be gone while the daemon still runs.
    const relays = await fresh([daemon('daemon-start-b', () => [])])
    const { pid, agent } = liveAgent()
    // Its agent still runs (its own token reads back): it may still write.
    expect(await relays.providerRelayRunLiveness(chat(relayed(exitedPid(), pid)))).toBe('unknown')
    // Its daemon still runs (same pid and start time), though its agent is gone: it may hold the run.
    const startedAtMs = await readProcessStartTimeMs(pid)
    const daemonAlive = {
      ...relayed(pid, exitedPid()),
      // Its own start: a start names one daemon process, so its proof is shared only within it.
      daemon: { instance: 'daemon-start-alive', pid, startedAtMs: startedAtMs ?? 1 }
    }
    expect(startedAtMs).not.toBeNull()
    expect(await relays.providerRelayRunLiveness(chat(daemonAlive))).toBe('unknown')
    agent.kill('SIGKILL')
    const goneRun = relayed(exitedPid(), exitedPid(), 'daemon-start-gone')
    expect(await relays.providerRelayRunLiveness(chat(goneRun))).toBe('gone')
  }
)

it('owner release keeps the run placement; only the next run replaces it', async () => {
  const { commitAgentSessionProcessIdentity, releaseUnprovenAgentSessionOwner } =
    await import('../../../../runtime/agent-session/ownership/agent-session-lease-transitions')
  const { agentSessionRunPlacement } =
    await import('../../../../../shared/agent-session/lifecycle/agent-session-run-placement')
  const reserved = {
    sessionId: SESSION,
    lease: {
      runtimeFence: 3,
      claimStatus: 'reserved',
      ownerProcess: null,
      reservedSpawnToken: 'kept-agent-token',
      handoffStage: 'new-owner-proving'
    }
  }
  const committed = commitAgentSessionProcessIdentity({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only these lease fields
    record: reserved as never,
    sessionId: SESSION,
    fence: 3,
    process: identity(42),
    placement: {
      kind: 'relayed',
      relayId: 'r-1',
      daemon: { instance: INSTANCE, pid: 7, startedAtMs: 1 }
    },
    now: 1
  })
  const placement = agentSessionRunPlacement(committed)
  expect(placement).toEqual(relayed(7, 42))
  const released = releaseUnprovenAgentSessionOwner({
    record: { ...committed, lease: { ...committed.lease, handoffStage: 'recovering' } },
    expectedFence: 3,
    now: 2
  })
  expect(released.lease.ownerProcess).toBeNull()
  expect(agentSessionRunPlacement(released)).toEqual(placement)
})

it.skipIf(process.platform === 'win32')(
  'a send to a chat held as unknown settles its gone run once, at the current fence, then starts fresh',
  async () => {
    const { pid, agent } = liveAgent()
    // No client speaks for the run's daemon start, which is gone; its agent outlives it a while.
    const relays = await fresh([daemon('daemon-start-b', () => [])])
    const record = chat(relayed(exitedPid(), pid))
    expect(await relays.providerRelayRunLiveness(record)).toBe('unknown')
    const { StructuredAgentSessionKeptOpens } =
      await import('../../delivery/structured-agent-session-kept-open-reconciler')
    const session = { child: null, journal: { cursor: () => ({ epoch: 'e', sequence: 5 }) } }
    const settle = vi.fn(async (_id: string, _open: unknown, _fence: number, _since: number) => {})
    const opens = new StructuredAgentSessionKeptOpens({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only child and journal.cursor
      sessions: new Map([[SESSION, session]]) as never,
      serialize: (_id, task) => task(),
      trackStart: (start) => start,
      record: () => record,
      // A send's reservation already moved the fence; writes go at the current one.
      fence: () => 4,
      settle,
      logger: { warn: () => {} }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only child and journal.cursor
    opens.adopted(SESSION, session as never)
    const launch = () =>
      relays.launchRelayedProviderProcess(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused or proven-gone launch reads no launch field
        {} as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused or proven-gone launch reads only chatKey
        { chatKey: SESSION } as never
      )
    await expect(launch()).rejects.toThrow('agent_kept_running_unreachable')
    expect(settle).not.toHaveBeenCalled()
    const exited = once(agent, 'exit')
    agent.kill('SIGKILL')
    await exited
    await expect(launch()).resolves.toBeNull()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(SESSION, session, 4, 6)
    // The run stays gone: a later start in the same outage is neither refused nor settled again.
    await expect(launch()).resolves.toBeNull()
    expect(settle).toHaveBeenCalledTimes(1)
    opens.dispose()
  }
)

// A launch reattach whose kept agent ended since must end as gone (its cut turn gets its offer),
// never quietly start a new agent in its place.
it.skipIf(process.platform === 'win32')(
  'a launch reattach whose kept agent is gone ends as gone instead of starting a new agent',
  async () => {
    const spawned: string[] = []
    const current = daemon(INSTANCE, () => [])
    const relays = await fresh([current])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spy keeps the fake's other members
    const client = current as unknown as { request: (type: string) => Promise<unknown> }
    const request = client.request
    client.request = (type) => {
      spawned.push(type)
      return request(type)
    }
    relays.installProviderRelayRunGate(async () => 'gone')
    const launch = relays.withProviderRelayRebind(SESSION, () =>
      relays.launchRelayedProviderProcess(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an ended rebind reads no launch field
        {} as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an ended rebind reads only chatKey
        { chatKey: SESSION } as never
      )
    )
    await expect(launch).rejects.toThrow('agent_kept_running_ended')
    expect(spawned).not.toContain('relaySpawn')
  }
)

// A start refused beside a possibly running kept agent proves no exit: death evidence from it would
// resettle the chat's last turn before the kept agent's buffered end replays.
it('a start refused beside an unreachable kept agent settles as unproven, however it is wrapped', async () => {
  vi.resetModules()
  const { KeptProviderRelayUnreachableError } =
    await import('../../../../provider-relay/provider-relay-kept-rebind')
  const { failedAcquisitionSettlement } =
    await import('../../acquisition/structured-agent-session-failed-create-refusal')
  const { AgentSessionAcquisitionExitProvenError } =
    await import('../../acquisition/structured-agent-session-acquisition-errors')
  const { AgentSessionPreSpawnError } =
    await import('../../providers/structured-agent-session-adapter-errors')
  const refused = new KeptProviderRelayUnreachableError(SESSION)
  const wording = { record: null, newSession: false }
  for (const error of [
    refused,
    new AgentSessionAcquisitionExitProvenError(refused),
    new AgentSessionPreSpawnError(refused)
  ]) {
    expect(failedAcquisitionSettlement(error, wording).exitProof).toBe('unproven')
  }
})
