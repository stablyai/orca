import { spawnSync } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../../../../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../../../../daemon/protocol/daemon-provider-relay-protocol'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

const SESSION = 'chat-with-held-approval'

const keptRelay = (chatKey: string): ProviderRelayInfo => ({
  relayId: `r-${chatKey}`,
  chatKey,
  agent: 'codex-test',
  pid: process.pid,
  spawnedAtMs: 1,
  attached: false,
  exit: null,
  nextSeq: 20,
  ackedSeq: 18,
  pendingCount: 1
})

/** A daemon whose relay listing answers only when the test says so. */
function lateDaemon() {
  let answer: (relays: ProviderRelayInfo[]) => void = () => {}
  const listed = new Promise<{ relays: ProviderRelayInfo[] }>((resolve) => {
    answer = (relays) => resolve({ relays })
  })
  const client = {
    getDaemonIdentity: () => ({ providerRelay: true, pid: 1 }),
    onEvent: () => () => {},
    onDisconnected: () => () => {},
    request: (type: string) => (type === 'relayList' ? listed : Promise.resolve({}))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory calls only these members
  return { client: client as unknown as DaemonClient, answer }
}

async function freshRelays(daemon: DaemonClient) {
  vi.resetModules()
  const relays = await import('../../../../provider-relay/app-provider-relays')
  relays.registerReattachableProviderRelayAgent('codex-test', { provider: 'codex' })
  relays.installProviderRelayRoute({
    current: async () => daemon,
    all: async () => [daemon],
    appVersion: 'test',
    idleStopMs: () => null
  })
  const open = await import('../structured-agent-session-kept-at-open')
  const { StructuredAgentSessionKeptOpens } =
    await import('../../delivery/structured-agent-session-kept-open-reconciler')
  return { relays, open, StructuredAgentSessionKeptOpens }
}

const owner = (pid: number, processStartTimeMs: number | null = null) => ({
  hostId: LOCAL_EXECUTION_HOST_ID,
  pid,
  processStartTimeMs,
  spawnToken: 'kept-agent-token'
})

const chat = (ownerProcess: ReturnType<typeof owner>) => ({
  sessionId: SESSION,
  provider: 'codex',
  location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
  ownerObservation: { ownerProcess }
})

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

type Fresh = Awaited<ReturnType<typeof freshRelays>>

/** One host's kept opens over the given open sessions; settle is the spy that a settle happened. */
function keptOpens(fresh: Fresh, sessions: Map<string, unknown>, ownerPid: () => number) {
  const settle = vi.fn(async () => {})
  const opens = new fresh.StructuredAgentSessionKeptOpens({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only child and journal.cursor
    sessions: sessions as never,
    serialize: (_id, task) => task(),
    trackStart: (start) => start,
    owner: () => owner(ownerPid()),
    fence: () => 3,
    settle,
    logger: { warn: () => {} }
  })
  return { opens, settle }
}

const openSession = () => ({
  child: null,
  journal: { cursor: () => ({ epoch: 'e', sequence: 5 }) }
})

async function settleTurns(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function openKept(
  fresh: Fresh,
  sessionId: string,
  ownerPid: number,
  waitMs = 1_000
): Promise<boolean> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
  const record = { ...chat(owner(ownerPid)), sessionId } as unknown as Parameters<
    typeof fresh.open.structuredAgentSessionKeptAtOpen
  >[0]
  return fresh.open.structuredAgentSessionKeptAtOpen(record, waitMs)
}

// A held approval must survive a launch whose relay listing is late: only proof ends the last run.
it.skipIf(process.platform === 'win32')(
  'opens a chat as kept while the listing is late, and settles it only once the listing proves its agent gone',
  async () => {
    const late = lateDaemon()
    const fresh = await freshRelays(late.client)
    expect(await openKept(fresh, SESSION, process.pid, 10)).toBe(true)
    const session = openSession()
    const { opens, settle } = keptOpens(fresh, new Map([[SESSION, session]]), () => process.pid)
    opens.adopted(SESSION, session as never)
    late.answer([keptRelay('another-chat')])
    await settleTurns()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith(SESSION, session, 3, 6)
  }
)

it.skipIf(process.platform === 'win32')(
  'never settles a chat the late listing shows kept',
  async () => {
    const late = lateDaemon()
    const fresh = await freshRelays(late.client)
    expect(await openKept(fresh, SESSION, process.pid, 10)).toBe(true)
    const session = openSession()
    const { opens, settle } = keptOpens(fresh, new Map([[SESSION, session]]), () => process.pid)
    opens.adopted(SESSION, session as never)
    late.answer([keptRelay(SESSION)])
    await settleTurns()
    expect(settle).not.toHaveBeenCalled()
  }
)

it.skipIf(process.platform === 'win32')(
  'settles at open when the owner process is proven gone, even while the listing is late',
  async () => {
    const fresh = await freshRelays(lateDaemon().client)
    expect(await openKept(fresh, SESSION, exitedPid())).toBe(false)
  }
)

it.skipIf(process.platform === 'win32')(
  'settles at open when the owner pid now names another process, even while the listing is late',
  async () => {
    const fresh = await freshRelays(lateDaemon().client)
    // The pid is live, but started long after the recorded owner: a reused pid, not the kept agent.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(owner(process.pid, 1)) as unknown as Parameters<
      typeof fresh.open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await fresh.open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(false)
  }
)

/** A daemon whose first listings fail; `recover()` makes later ones answer, without any chat. */
function downDaemon() {
  let up = false
  const client = {
    getDaemonIdentity: () => ({ providerRelay: true, pid: 1 }),
    onEvent: () => () => {},
    onDisconnected: () => () => {},
    request: (type: string) =>
      type !== 'relayList'
        ? Promise.resolve({})
        : up
          ? Promise.resolve({ relays: [] })
          : Promise.reject(new Error('daemon down'))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory calls only these members
  return { client: client as unknown as DaemonClient, recover: () => (up = true) }
}

it.skipIf(process.platform === 'win32')(
  'through a daemon outage, settles only chats still open when the inventory completes, once each',
  async () => {
    const daemon = downDaemon()
    const fresh = await freshRelays(daemon.client)
    const inventory = await import('../../../../provider-relay/provider-relay-launch-inventory')
    const sessions = new Map<string, unknown>()
    const { opens, settle } = keptOpens(fresh, sessions, () => process.pid)
    const chats = Array.from({ length: 1_000 }, (_, i) => `chat-${i}`)
    for (const id of chats) {
      expect(await openKept(fresh, id, process.pid)).toBe(true)
      const session = openSession()
      sessions.set(id, session)
      opens.adopted(id, session as never)
      opens.adopted(id, session as never)
    }
    await settleTurns()
    expect(settle).not.toHaveBeenCalled()
    // Every chat but one closes while the daemon is down.
    for (const id of chats.slice(1)) {
      sessions.delete(id)
    }
    daemon.recover()
    await inventory.listKeptProviderRelays(async () => [daemon.client], true)
    await settleTurns()
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle.mock.calls[0]?.[0]).toBe('chat-0')
  }
)

it.skipIf(process.platform === 'win32')(
  'lets a send start a fresh agent once the owner is proven gone, though no listing ever answers',
  async () => {
    const daemon = downDaemon()
    const fresh = await freshRelays(daemon.client)
    expect(await openKept(fresh, SESSION, process.pid)).toBe(true)
    const session = openSession()
    let ownerPid = process.pid
    const { opens, settle } = keptOpens(fresh, new Map([[SESSION, session]]), () => ownerPid)
    opens.adopted(SESSION, session as never)
    await settleTurns()
    expect(settle).not.toHaveBeenCalled()
    ownerPid = exitedPid()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused or proven-gone launch reads only chatKey
    await expect(
      fresh.relays.launchRelayedProviderProcess({} as never, { chatKey: SESSION } as never)
    ).resolves.toBeNull()
    expect(settle).toHaveBeenCalledTimes(1)
  }
)
