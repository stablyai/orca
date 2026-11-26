import { spawnSync } from 'node:child_process'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../../../../daemon/transport/client/daemon-client'
import type { ProviderRelayInfo } from '../../../../daemon/protocol/daemon-provider-relay-protocol'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

const SESSION = 'chat-with-held-approval'

const keptRelay = (chatKey: string, pid: number | null = process.pid): ProviderRelayInfo => ({
  relayId: `r-${chatKey}`,
  chatKey,
  agent: 'codex-test',
  pid,
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
  // An ACP agent: one that ended while Orca was closed still opens, to replay its output.
  relays.registerReattachableProviderRelayAgent('acp:qwen-test', {
    provider: 'qwen-code',
    opensEnded: true
  })
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

const chat = (ownerProcess: ReturnType<typeof owner>, provider = 'codex') => ({
  sessionId: SESSION,
  provider,
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
/** `ownerOf` null keeps the reconciler from probing processes, so nothing runs behind the test. */
function keptOpens(
  fresh: Fresh,
  sessions: Map<string, unknown>,
  ownerOf: () => ReturnType<typeof owner> | null = () => null
) {
  const settle = vi.fn(async (_id: string, _open: unknown, _fence: number, _since: number) => {})
  const opens = new fresh.StructuredAgentSessionKeptOpens({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only child and journal.cursor
    sessions: sessions as never,
    serialize: (_id, task) => task(),
    trackStart: (start) => start,
    owner: ownerOf,
    fence: () => 3,
    settle,
    logger: { warn: () => {} }
  })
  const adopt = (id: string, session: ReturnType<typeof openSession>): void =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reconciler reads only child and journal.cursor
    opens.adopted(id, session as never)
  return { opens, settle, adopt }
}

const openSession = () => ({
  child: null,
  journal: { cursor: () => ({ epoch: 'e', sequence: 5 }) }
})

/** Lets the promise chains the fakes started run out; every fake answers without real I/O. */
async function settleTurns(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve()
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
    const { adopt, settle } = keptOpens(fresh, new Map([[SESSION, session]]))
    adopt(SESSION, session)
    // Another chat's relay with no process, so the listing reads no process before it settles.
    late.answer([keptRelay('another-chat', null)])
    await fresh.relays.providerRelayListingSettled()
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
    const { adopt, settle } = keptOpens(fresh, new Map([[SESSION, session]]))
    adopt(SESSION, session)
    late.answer([keptRelay(SESSION)])
    await settleTurns()
    expect(settle).not.toHaveBeenCalled()
  }
)

// QA r20: launch recovery had released the S1 chat's recorded owner, so its open settled the run
// the relay still held, 45 ms before the reattach.
it.skipIf(process.platform === 'win32')(
  'keeps a chat the listing shows kept even when its recorded owner was released',
  async () => {
    const late = lateDaemon()
    const fresh = await freshRelays(late.client)
    late.answer([keptRelay(SESSION)])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = {
      ...chat(owner(process.pid)),
      ownerObservation: { ownerProcess: null }
    } as unknown as Parameters<typeof fresh.open.structuredAgentSessionKeptAtOpen>[0]
    expect(await fresh.open.structuredAgentSessionKeptAtOpen(record, 5_000)).toBe(true)
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
    const { adopt, settle } = keptOpens(fresh, sessions)
    const chats = Array.from({ length: 1_000 }, (_, i) => `chat-${i}`)
    for (const id of chats) {
      expect(await openKept(fresh, id, process.pid)).toBe(true)
      const session = openSession()
      sessions.set(id, session)
      adopt(id, session)
      adopt(id, session)
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
    expect(settle).toHaveBeenCalledWith('chat-0', expect.anything(), 3, 6)
  }
)

it.skipIf(process.platform === 'win32')(
  'lets a send start a fresh agent once the owner is proven gone, though no listing ever answers',
  async () => {
    const daemon = downDaemon()
    const fresh = await freshRelays(daemon.client)
    expect(await openKept(fresh, SESSION, process.pid)).toBe(true)
    const session = openSession()
    let ownerNow: ReturnType<typeof owner> | null = null
    const { adopt, settle } = keptOpens(fresh, new Map([[SESSION, session]]), () => ownerNow)
    adopt(SESSION, session)
    await settleTurns()
    expect(settle).not.toHaveBeenCalled()
    ownerNow = owner(exitedPid())
    const launched = fresh.relays.launchRelayedProviderProcess(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused or proven-gone launch reads no launch field
      {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a refused or proven-gone launch reads only chatKey
      { chatKey: SESSION } as never
    )
    await expect(launched).resolves.toBeNull()
    expect(settle).toHaveBeenCalledTimes(1)
  }
)

it.skipIf(process.platform === 'win32')(
  'opens a chat whose ended agent still opens as kept while the listing is late, though its process is gone',
  async () => {
    const { open } = await freshRelays(lateDaemon().client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(owner(exitedPid()), 'qwen-code') as unknown as Parameters<
      typeof open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(true)
  }
)
