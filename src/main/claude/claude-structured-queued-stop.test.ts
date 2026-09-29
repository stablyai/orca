// A send Claude queued behind the running turn is dropped by Stop, so it must settle as withdrawn.
// Orca's SessionStart hook proves most starts before the turn's system/init, which is the only
// frame that says whether the CLI can cancel its queue.

import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/structured-agent-session-dispatch-rejection'
import type { ClaudeStructuredSessionAdapterDeps } from './claude-structured-session-state'
import { CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS } from './claude-structured-prompt-ownership'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  adapterFor,
  fakeClaude,
  identityFor,
  type FakeConnection
} from './claude-structured-session-test-support'

// As Claude Code 2.1.280 advertises them on a turn's system/init frame.
const CAPABILITIES = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1']

type Settlement = Parameters<
  NonNullable<ClaudeStructuredSessionAdapterDeps['onDispatchSettledLate']>
>[0]

/** Answers the way the real CLI does: cancel_queued cancels the queue, a plain interrupt keeps it. */
function claudeCli(options: Parameters<typeof fakeClaude>[0] = {}) {
  let queued: string[] = []
  const claude = fakeClaude({
    replayUuid: null,
    ...options,
    routes: {
      interrupt: (params) =>
        params?.cancelQueued
          ? { still_queued: [], cancelled: queued.splice(0) }
          : { still_queued: [...queued] },
      cancel_async_message: (params) => {
        const before = queued.length
        queued = queued.filter((uuid) => uuid !== params?.uuid)
        return queued.length < before
      }
    }
  })
  return { claude, queue: (uuid: string) => queued.push(uuid) }
}

function turnInit(capabilities?: string[]): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init',
    model: 'claude-sonnet-5',
    ...(capabilities ? { capabilities } : {})
  }
}

async function acquired(
  claude: ReturnType<typeof fakeClaude>,
  settlements: Settlement[] = []
): Promise<{
  adapter: ReturnType<typeof adapterFor>
  bodies: Map<string, AgentJournalItemBody>
  connection: FakeConnection
}> {
  const bodies = new Map<string, AgentJournalItemBody>()
  const adapter = adapterFor(claude, {}, [], [], undefined, undefined, undefined, (settlement) =>
    settlements.push(settlement)
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: {
      appendItem: (identity, body) => bodies.set(agentJournalItemKey(identity), body),
      appendTombstone: (identity) => bodies.delete(agentJournalItemKey(identity)),
      publish: vi.fn()
    }
  })
  return { adapter, bodies, connection: claude.connections[0]! }
}

function runningTurnId(bodies: Map<string, AgentJournalItemBody>): string {
  for (const body of bodies.values()) {
    const turn = readAgentJournalTurn(body)
    if (turn?.state === 'running') {
      return turn.turnId
    }
  }
  throw new Error('expected a running turn')
}

/** Sends A and opens its turn, queues B behind it, then Stops A as the host does. */
async function stopWithQueuedFollowUp(
  cli: ReturnType<typeof claudeCli>,
  openTurn: (connection: FakeConnection) => void
): Promise<{ interrupt: unknown; settlements: Settlement[] }> {
  const settlements: Settlement[] = []
  const { adapter, bodies, connection } = await acquired(cli.claude, settlements)
  const send = (clientMessageId: string) =>
    adapter.dispatch({ sessionId: 'session-1', clientMessageId, body: USER_MESSAGE, fence: 7 })
  await send('client-a')
  openTurn(connection)
  // Claude adopts the client uuid for the echo that opens the turn.
  connection.handlers.onMessage?.({
    ...connection.sent.at(-1)!,
    uuid: connection.sent.at(-1)!.uuid
  })
  await send('client-b')
  cli.queue(String(connection.sent.at(-1)!.uuid))

  vi.useFakeTimers()
  try {
    const stopped = adapter.cancelTurn({
      sessionId: 'session-1',
      turnId: runningTurnId(bodies),
      fence: 7,
      // The host reads B's handover from the journal, and it is still pending.
      dispatchStatus: { state: 'pending', recovered: false }
    })
    await vi.advanceTimersByTimeAsync(CLAUDE_DISPATCH_ADMISSION_TIMEOUT_MS)
    await expect(stopped).resolves.toEqual({ cancelled: true })
  } finally {
    vi.useRealTimers()
  }
  return {
    interrupt: connection.calls.find((call) => call.subtype === 'interrupt')?.params,
    settlements: settlements.filter((settlement) => settlement.clientMessageId === 'client-b')
  }
}

const WITHDRAWN = [
  {
    sessionId: 'session-1',
    clientMessageId: 'client-b',
    state: 'rejected',
    reason: DISPATCH_REJECTED_CANCELLED,
    rejection: { kind: 'cancelled' }
  }
]

describe('Stop with a follow-up Claude queued behind the running turn', () => {
  it('withdraws it the same way whether system/init or a SessionStart hook proved the start', async () => {
    const byInit = await stopWithQueuedFollowUp(
      claudeCli({ initProof: 'init', capabilities: CAPABILITIES }),
      () => {}
    )
    const bySessionStart = await stopWithQueuedFollowUp(
      claudeCli({ initProof: 'session-start' }),
      (connection) => connection.handlers.onMessage?.(turnInit(CAPABILITIES))
    )

    expect(byInit).toEqual({ interrupt: { cancelQueued: true }, settlements: WITHDRAWN })
    expect(bySessionStart).toEqual(byInit)
  })

  it('keeps what a turn advertised when a later frame names nothing', async () => {
    const result = await stopWithQueuedFollowUp(
      claudeCli({ initProof: 'session-start' }),
      (connection) => {
        connection.handlers.onMessage?.(turnInit(CAPABILITIES))
        connection.handlers.onMessage?.(turnInit())
        connection.handlers.onMessage?.({
          type: 'system',
          subtype: 'hook_response',
          hook_name: 'SessionStart:resume',
          session_id: PROVIDER_SESSION_ID
        })
      }
    )

    expect(result).toEqual({ interrupt: { cancelQueued: true }, settlements: WITHDRAWN })
  })

  it('keeps what a turn advertised when the start is read after it', async () => {
    const cli = claudeCli({ initProof: 'session-start' })
    const open = cli.claude.openConnection
    // The turn's init lands while startup still waits on get_settings, as a send that starts the
    // agent allows.
    cli.claude.openConnection = async (launch, handlers) => {
      const connection = await open(launch, handlers)
      const getSettings = connection.getSettings
      connection.getSettings = async (options) => {
        handlers?.onMessage?.(turnInit(CAPABILITIES))
        return getSettings(options)
      }
      return connection
    }

    const result = await stopWithQueuedFollowUp(cli, () => {})

    expect(result).toEqual({ interrupt: { cancelQueued: true }, settlements: WITHDRAWN })
  })

  it('settles a follow-up withdrawn one at a time on a CLI without cancel_queued', async () => {
    const result = await stopWithQueuedFollowUp(
      claudeCli({ initProof: 'init', capabilities: ['interrupt_receipt_v1'] }),
      () => {}
    )

    expect(result).toEqual({ interrupt: {}, settlements: WITHDRAWN })
  })
})
