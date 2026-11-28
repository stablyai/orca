// A turn/start Codex steers into a turn already running joins that turn, which another send opened:
// its echo there records the join, as a steer's does, so whom the turn answered (and who typed in
// it) includes it. A start that opens its own fresh turn records no join.
import { describe, expect, it, vi } from 'vitest'
import { createCodexDispatchEchoes } from './codex-structured-dispatch-echo'
import {
  codexAcceptedSend,
  codexEchoVia
} from '../journal/codex-structured-journal-translation-turns'

const { running } = vi.hoisted((): { running: { turnId: string | null } } => ({
  running: { turnId: null }
}))
// The provider's own answers: whether a turn runs, and (below) the turn/start reply.
vi.mock('./codex-structured-turn-open-wait', () => ({
  codexRunningOrOpeningTurn: async () => running.turnId,
  codexStopTarget: () => null
}))
// Fresh input needs no permission prompt here; the write itself is the real one.
vi.mock('./codex-structured-turn-permission', () => ({
  admitCodexTurnPermission: async (
    _host: unknown,
    _admit: unknown,
    write: (permission: Record<string, unknown>) => { response: Promise<unknown> }
  ) => write({}).response
}))

import { startCodexTurn } from './codex-structured-turn-start'

const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }

/** A host with one turn running that takes no steer (interrupt-acknowledged), so the send falls
 *  back to turn/start; Codex answers it with `replyTurnId`. */
function hostWith(runningTurnId: string | null, replyTurnId: string) {
  running.turnId = runningTurnId
  const dispatchEchoes = createCodexDispatchEchoes()
  const request = vi.fn(async () => ({ turn: { id: replyTurnId } }))
  const host = {
    threadId: 'thread',
    activeTurnIds: new Set(runningTurnId ? [runningTurnId] : []),
    abortedTurnIds: new Set(runningTurnId ? [runningTurnId] : []),
    options: new Map<string, string>(),
    dispatchEchoes,
    connection: { request }
  }
  return { host, dispatchEchoes, request }
}

async function started(runningTurnId: string | null, replyTurnId: string) {
  const { host, dispatchEchoes, request } = hostWith(runningTurnId, replyTurnId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reads only these host fields here.
  const codexHost = host as unknown as Parameters<typeof startCodexTurn>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a send with only the fields the start reads.
  const send = { clientMessageId: 'c2', body, requestedAt: 1 } as unknown as Parameters<
    typeof startCodexTurn
  >[1]
  const answer = await startCodexTurn(codexHost, send)
  expect(request).toHaveBeenCalledWith('turn/start', expect.anything(), expect.anything())
  // The provider's echo of the send, in the turn it landed in.
  const echo = (turnId: string) =>
    codexAcceptedSend(
      'chat',
      { provider: 'codex', threadId: 'thread', turnId, ordinal: 1 },
      dispatchEchoes.sentVia('c2', turnId)
    )
  return { answer, echo }
}

describe('a turn/start written while a turn runs', () => {
  it('joins the running turn when Codex steers it there', async () => {
    const { answer, echo } = await started('turn-1', 'turn-1')
    expect(answer).toMatchObject({ via: 'start' })
    expect(echo('turn-1').answeredInTurn).toMatchObject({ via: 'steer' })
  })

  it('joins a turn Codex answered before Orca saw it start', async () => {
    // An earlier send's turn/start named turn-1; its turn/started is not translated yet.
    const { host, dispatchEchoes } = hostWith(null, 'turn-1')
    dispatchEchoes.arm('c1', 0)
    dispatchEchoes.bindTurn('c1', 'thread', 'turn-1', 'start')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reads only these host fields here.
    const codexHost = host as unknown as Parameters<typeof startCodexTurn>[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a send with only the fields the start reads.
    const send = { clientMessageId: 'c2', body, requestedAt: 1 } as unknown as Parameters<
      typeof startCodexTurn
    >[1]
    await startCodexTurn(codexHost, send)
    const joined = codexAcceptedSend(
      'chat',
      { provider: 'codex', threadId: 'thread', turnId: 'turn-1', ordinal: 1 },
      dispatchEchoes.sentVia('c2', 'turn-1')
    )
    expect(joined.answeredInTurn).toMatchObject({ via: 'steer' })
  })

  it('joins the turn an earlier start opened, though that start never learned its turn', async () => {
    // A's turn/start timed out: Orca never bound its turn, and nothing is running or opening.
    const { host, dispatchEchoes } = hostWith(null, 'turn-9')
    dispatchEchoes.arm('a', 0)
    dispatchEchoes.expect('a', 'thread', 'start', [{ type: 'text', text: 'a' }])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reads only these host fields here.
    const codexHost = host as unknown as Parameters<typeof startCodexTurn>[0]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a send with only the fields the start reads.
    const send = { clientMessageId: 'c2', body, requestedAt: 1 } as unknown as Parameters<
      typeof startCodexTurn
    >[1]
    // B is written as a start; Codex's reply names some turn, but only the echoes say where it went.
    await startCodexTurn(codexHost, send)
    const echoInto = (clientMessageId: string, turnId: string) => {
      const identity = { provider: 'codex' as const, threadId: 'thread', turnId, ordinal: 0 }
      return codexAcceptedSend(
        'chat',
        identity,
        codexEchoVia(dispatchEchoes, clientMessageId, identity)
      )
    }
    // A's echo opens turn T; B's echo into T joined it.
    expect(echoInto('a', 'turn-t').answeredInTurn).toBeUndefined()
    expect(echoInto('c2', 'turn-t').answeredInTurn).toMatchObject({ via: 'steer' })
    // A repeated echo of A is still its own turn's opener.
    expect(echoInto('a', 'turn-t').answeredInTurn).toBeUndefined()
  })

  it('reads a join the same on a repeated echo after the send settled', () => {
    const echoes = createCodexDispatchEchoes()
    for (const id of ['a', 'b']) {
      echoes.arm(id, 0)
      echoes.expect(id, 'thread', 'start', [{ type: 'text', text: id }])
    }
    const into = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn-t', ordinal: 0 }
    expect(codexEchoVia(echoes, 'a', into)).toBe('start')
    expect(codexEchoVia(echoes, 'b', into)).toBe('steer')
    // Its first write settles (forgets) the send; Codex echoes the item again on completion, and
    // that write must still record the join if the first one rolled back.
    echoes.settle('b')
    expect(codexEchoVia(echoes, 'b', into)).toBe('steer')
    echoes.settle('a')
    expect(codexEchoVia(echoes, 'a', into)).toBe('start')
  })

  it('keeps a fresh start its own turn, and an explicit steer a join', () => {
    const echoes = createCodexDispatchEchoes()
    echoes.arm('a', 0)
    echoes.expect('a', 'thread', 'start', [{ type: 'text', text: 'a' }])
    echoes.arm('s', 1)
    echoes.expect('s', 'thread', 'steer', [{ type: 'text', text: 's' }], 'turn-1')
    const identity = (turnId: string) => ({
      provider: 'codex' as const,
      threadId: 'thread',
      turnId,
      ordinal: 0
    })
    // A start echoed first into its turn opened it.
    expect(codexEchoVia(echoes, 'a', identity('turn-2'))).toBe('start')
    // A steer is a join wherever it lands, first or not.
    expect(codexEchoVia(echoes, 's', identity('turn-1'))).toBe('steer')
  })

  it('opens its own turn when Codex starts a fresh one', async () => {
    const { echo } = await started('turn-1', 'turn-2')
    expect(echo('turn-2').answeredInTurn).toBeUndefined()
    // With no turn running, a start always opens its own.
    const fresh = await started(null, 'turn-3')
    expect(fresh.echo('turn-3').answeredInTurn).toBeUndefined()
  })
})
