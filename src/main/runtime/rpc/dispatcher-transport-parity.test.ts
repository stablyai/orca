import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import '../orchestration/db/contract-constants'
import '../orchestration/db/messages/mailbox-routing-page'
import '../orchestration/db/dispatch-row-writer'
import '../orchestration/db/attempt-outcome-projection'
import {
  defineMethod,
  type RpcAnyMethodDeclaration,
  type RpcRequest,
  type RpcResponse
} from './core'
import { RpcDispatcher } from './dispatcher'
import {
  attachMutationReplayNudge,
  stripMutationReplayNudge
} from './orchestration-mutation-receipt'

type Transport = 'dispatch' | 'streaming'
const TRANSPORTS: readonly Transport[] = ['dispatch', 'streaming']
const AnyParams = z.record(z.string(), z.unknown())
const databases: OrchestrationDb[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.restoreAllMocks()
})

function createDispatcher(methods: readonly RpcAnyMethodDeclaration[]): RpcDispatcher {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
    ptyId: 'pty-prompt',
    processIncarnation: 'incarnation-1',
    generation: 1
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('window-1:leaf-prompt')
  return new RpcDispatcher({ runtime, methods })
}

async function call(
  dispatcher: RpcDispatcher,
  transport: Transport,
  request: RpcRequest,
  options?: Parameters<RpcDispatcher['dispatch']>[1]
): Promise<RpcResponse> {
  if (transport === 'dispatch') {
    return dispatcher.dispatch(request, options)
  }
  const replies: string[] = []
  await dispatcher.dispatchStreaming(request, (reply) => replies.push(reply), options)
  return JSON.parse(replies[0]!)
}

function mutationRequest(method: string, params: unknown, requestId: string): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method,
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: requestId,
    params
  }
}

describe('RpcDispatcher unary transport parity', () => {
  it.each(TRANSPORTS)('keeps an ambiguous prompt receipt over %s', async (transport) => {
    const handler = vi.fn((_params: unknown, ctx: { markMutationEffectPossible?: () => void }) => {
      ctx.markMutationEffectPossible?.()
      throw new Error('terminal_not_writable')
    })
    const dispatcher = createDispatcher([
      defineMethod({ name: 'terminal.send', permission: 'workspace', params: AnyParams, handler })
    ])
    const request = mutationRequest(
      'terminal.send',
      {
        terminal: 'term-prompt',
        text: 'go',
        enter: true,
        agentPrompt: true,
        client: { id: 'orca-cli', type: 'desktop' }
      },
      'post-write'
    )

    await expect(call(dispatcher, transport, request)).resolves.toMatchObject({ ok: false })
    await expect(call(dispatcher, transport, request)).resolves.toMatchObject({
      ok: false,
      error: { code: 'operation_unknown' }
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('returns the same de-nudged replay receipt over both transports', async () => {
    const replays = await Promise.all(
      TRANSPORTS.map(async (transport) => {
        const dispatcher = createDispatcher([
          defineMethod({
            name: 'orchestration.send',
            permission: 'workspace',
            params: AnyParams,
            handler: (_params, { replayedMutationReceipt }) =>
              replayedMutationReceipt
                ? stripMutationReplayNudge(replayedMutationReceipt)
                : attachMutationReplayNudge(
                    { messageId: 'msg_1' },
                    { kind: 'messages', targets: [{ to: 'term_peer', type: 'status' }] }
                  )
          })
        ])
        const request = mutationRequest('orchestration.send', { to: 'term_peer' }, 'send-1')
        await call(dispatcher, transport, request)
        return call(dispatcher, transport, request)
      })
    )

    const results = replays.map((reply) => (reply.ok ? reply.result : reply.error))
    expect(results[0]).toEqual({
      messageId: 'msg_1',
      mutation: { requestId: 'send-1', replayed: true }
    })
    expect(results[1]).toEqual(results[0])
  })
})
