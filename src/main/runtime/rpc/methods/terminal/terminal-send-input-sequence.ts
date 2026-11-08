import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../../../shared/terminal/input/terminal-input'
import {
  TerminalOpenInputSession,
  type TerminalSend
} from '../../../../../shared/rpc-contract/terminal-unary-params'
import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-send-contract'
import {
  terminalOrderedInputControls,
  terminalOrderedInputByteLength,
  TERMINAL_ORDERED_INPUT_MAX_BYTES,
  type TerminalInputSessionBinding
} from '../../../../../shared/terminal/input/terminal-ordered-input'
import { defineMethod, type RpcContext } from '../../core'
import { getTerminalInputSequenceLedger } from './terminal-input-sequence-ledger'

type SendParams = z.infer<typeof TerminalSend>
type BeforeWrite = (ptyId?: string) => void
const refused = (handle: string) => ({ send: { handle, accepted: false, bytesWritten: 0 } })

function mobileOwner(
  params: { client?: { type?: string; id: string } },
  context: RpcContext
): string | null {
  return params.client?.type === 'mobile' &&
    context.caller?.kind === 'paired-device' &&
    (!context.clientId || context.clientId === params.client.id)
    ? context.caller.deviceId
    : null
}

export const TERMINAL_INPUT_SESSION_METHOD = defineMethod({
  name: 'terminal.openInputSession',
  permission: 'workspace',
  params: TerminalOpenInputSession,
  handler: (params, context) => {
    const owner = mobileOwner(params, context)
    const inputSessionId =
      owner && !context.signal?.aborted
        ? getTerminalInputSequenceLedger(context.runtime).openStrictSession(
            owner,
            context.runtime.getTerminalPromptRequestBinding(params.terminal)
          )
        : null
    return { inputSessionId }
  }
})

export function withTerminalInputSequence(
  send: (
    params: SendParams,
    context: RpcContext,
    assertBinding?: BeforeWrite
  ) => Promise<{ send: RuntimeTerminalSend }>
): (params: SendParams, context: RpcContext) => Promise<{ send: RuntimeTerminalSend }> {
  return (params, context) => {
    const { runtime, signal } = context
    const owner = mobileOwner(params, context)
    const ledger = getTerminalInputSequenceLedger(runtime)
    if (!params.inputSequence) {
      if (params.inputKind === 'query-reply') {
        return send(params, context)
      }
      const ptyId = owner ? runtime.resolveLiveLeafForHandle(params.terminal)?.ptyId : null
      if (ptyId && owner && ledger.hasPendingStrict(ptyId, owner)) {
        return Promise.resolve(refused(params.terminal))
      }
      return ptyId && owner
        ? ledger.trackLegacy(ptyId, owner, () => send(params, context))
        : send(params, context)
    }
    if (
      !owner ||
      signal?.aborted ||
      (params.text?.length ?? 0) > TERMINAL_INPUT_MAX_BYTES ||
      params.inputKind === 'query-reply'
    ) {
      return Promise.resolve(refused(params.terminal))
    }
    const { sessionId, seq } = params.inputSequence
    const bytes = terminalOrderedInputByteLength(params)
    params = { ...params, ...terminalOrderedInputControls(params) }
    const current = runtime.getTerminalPromptRequestBinding(params.terminal)
    const assertBinding = (expected: TerminalInputSessionBinding, writePtyId?: string) => {
      const actual = runtime.getTerminalPromptRequestBinding(params.terminal)
      if (
        signal?.aborted ||
        (writePtyId !== undefined && writePtyId !== expected.ptyId) ||
        actual.ptyId !== expected.ptyId ||
        actual.processIncarnation !== expected.processIncarnation ||
        actual.generation !== expected.generation ||
        !ledger.isStrictSessionCurrent(expected.ptyId, owner, sessionId)
      ) {
        throw new Error('terminal_input_session_replaced')
      }
    }
    const fingerprint =
      bytes > TERMINAL_ORDERED_INPUT_MAX_BYTES
        ? ''
        : createHash('sha256')
            .update(JSON.stringify({ ...params, inputSequence: undefined }))
            .digest('hex')
    let result: { send: RuntimeTerminalSend } | undefined
    return ledger
      .admitStrict(
        current.ptyId,
        owner,
        sessionId,
        seq,
        bytes,
        fingerprint,
        assertBinding,
        async (binding) => {
          result = await send(params, context, (ptyId) => assertBinding(binding, ptyId))
          // The existing handler owns this result; the sequence ledger only interprets its provider receipt.
          const receipt = result.send
          if (receipt?.writeSettlement?.outcome === 'unverifiable') {
            return 'delivery-unknown'
          }
          return receipt?.accepted === true ? 'applied' : 'refused'
        }
      )
      .then((admission) => {
        if (result !== undefined && admission.kind === 'applied') {
          return result
        }
        return admission.kind === 'applied'
          ? { send: { handle: params.terminal, accepted: true, bytesWritten: 0 } }
          : refused(params.terminal)
      })
  }
}
