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
  return { relays, open }
}

const chat = (ownerPid: number, provider = 'codex') => ({
  sessionId: SESSION,
  provider,
  location: { executionHostId: LOCAL_EXECUTION_HOST_ID },
  ownerObservation: { ownerProcess: { pid: ownerPid } }
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

// A held approval must survive a launch whose relay listing is late: only proof ends the last run.
it.skipIf(process.platform === 'win32')(
  'opens a chat as kept while the listing is late, and settles it only once the listing proves its agent gone',
  async () => {
    const late = lateDaemon()
    const { open } = await freshRelays(late.client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(process.pid) as unknown as Parameters<
      typeof open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(true)

    const settled = vi.fn(async () => {})
    const reconciled = open.reconcileStructuredAgentSessionKeptAtOpen(SESSION, settled)
    late.answer([keptRelay('another-chat')])
    await reconciled
    expect(settled).toHaveBeenCalledTimes(1)
  }
)

it.skipIf(process.platform === 'win32')(
  'never settles a chat the late listing shows kept',
  async () => {
    const late = lateDaemon()
    const { open } = await freshRelays(late.client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(process.pid) as unknown as Parameters<
      typeof open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(true)

    const settled = vi.fn(async () => {})
    const reconciled = open.reconcileStructuredAgentSessionKeptAtOpen(SESSION, settled)
    late.answer([keptRelay(SESSION)])
    await reconciled
    expect(settled).not.toHaveBeenCalled()
  }
)

it.skipIf(process.platform === 'win32')(
  'settles at open when the owner process is proven gone, even while the listing is late',
  async () => {
    const { open } = await freshRelays(lateDaemon().client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(exitedPid()) as unknown as Parameters<
      typeof open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(false)
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps a chat whose ended agent still opens until the late listing answers, though its process is gone',
  async () => {
    const late = lateDaemon()
    const { open } = await freshRelays(late.client)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verdict reads only these fields
    const record = chat(exitedPid(), 'qwen-code') as unknown as Parameters<
      typeof open.structuredAgentSessionKeptAtOpen
    >[0]
    expect(await open.structuredAgentSessionKeptAtOpen(record, 10)).toBe(true)

    const settled = vi.fn(async () => {})
    const reconciled = open.reconcileStructuredAgentSessionKeptAtOpen(SESSION, settled)
    late.answer([
      { ...keptRelay(SESSION), agent: 'acp:qwen-test', exit: { code: 0, signal: null } }
    ])
    await reconciled
    expect(settled).not.toHaveBeenCalled()
  }
)
