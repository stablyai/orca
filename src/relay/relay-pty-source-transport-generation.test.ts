import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type RequestContext,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

/**
 * A reconnected client must be distinguishable from one that never disconnected.
 *
 * setWrite() revives the primary client without changing its id, so activate()'s
 * `record.clientId === context.clientId` test answered yes across a reconnect and returned
 * 'existing' before ever reading the recovery argument. Checkpointed source recovery therefore
 * never ran on an SSH reconnect (docs/reference/ssh-reconnect-source-recovery.md).
 *
 * Scope, because it is easy to over-read: this restores the relay's ability to *notice* a
 * reconnect. It is not what caused the transport-drop data loss — that was the pty pausing with no
 * client to drain to, fixed separately in pty-handler. Both were needed.
 */
const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('pty source activation across a transport change', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  async function createHarness() {
    const settlements: ((result: SinkWriteSettlement) => void)[] = []
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    return { publication, settlements }
  }

  function contextOn(
    transportGeneration: number | undefined,
    settlements: unknown[]
  ): RequestContext {
    return {
      clientId: 1,
      ...(transportGeneration === undefined ? {} : { transportGeneration }),
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (callback) => settlements.push(callback)
    }
  }

  it('still short-circuits when the same client re-activates on the same transport', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe('opened')
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })

    // Why this case matters: a plain re-attach on a live transport must keep costing nothing.
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe(
      'existing'
    )
  })

  it('does not claim "existing" when the client returns on a new transport', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe('opened')
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })

    // Same clientId, next transport incarnation — what a reconnect actually looks like.
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(1, settlements))).not.toBe(
      'existing'
    )
  })

  it('keeps the id-only answer for callers that do not model transports', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(undefined, settlements))).toBe(
      'opened'
    )
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })

    // Why: harnesses and non-dispatcher callers omit the field; they must not start rotating on
    // every attach just because the comparison grew a second term.
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(undefined, settlements))).toBe(
      'existing'
    )
  })
})
