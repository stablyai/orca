import { defineMethod, type RpcContext } from '../core'
import { RegisterGeneratedInputNoticeParams } from '../../../../shared/rpc-contract/generated-input-params'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { GeneratedInputParts } from './generated-input-parts'

const parts = new GeneratedInputParts()

/** The logical window (or device) a private notice belongs to, stable across a renderer reload
 *  and never the replaceable socket. Null when the caller cannot be told apart from others. */
export function generatedInputNoticeViewer(context: RpcContext): string | null {
  if (context.noticeOrigin) {
    return context.noticeOrigin
  }
  if (context.pairedDeviceId) {
    return `device:${context.pairedDeviceId}`
  }
  return null
}

export const GENERATED_INPUT_NOTICE_REGISTER_METHODS = [
  // Registers one operation's failure notice for the caller's window, or settles its pending
  // record. It never writes to a terminal; registering again is harmless (one record per id).
  defineMethod({
    name: 'terminal.generatedInputNotices.register',
    permission: 'workspace',
    params: RegisterGeneratedInputNoticeParams,
    handler: async (params, context) => {
      const origin = generatedInputNoticeViewer(context)
      // Without a window identity a private notice would have no audience but everyone's.
      if (!origin) {
        return { retained: false }
      }
      const notices = context.runtime.generatedInputNotices
      if (params.settle) {
        notices.settle(params.id, origin)
        return { settled: true }
      }
      const binding = JSON.stringify([params.id, params.agent, params.certainty, params.submitted])
      const staged = parts.accept(context.connectionId ?? 'inproc', params, binding)
      if (staged.kind === 'pending') {
        return { part: 'accepted' as const }
      }
      const { retained } = notices.upsert({
        id: params.id,
        origin,
        text: staged.text,
        agent: params.agent && isTuiAgent(params.agent) ? params.agent : null,
        certainty: params.certainty,
        ...(params.submitted === false ? { submitted: false } : {}),
        handle: params.handle ?? '',
        worktreeId: params.worktreeId ?? '',
        ptyId: params.ptyId ?? null,
        pending: params.pending === true,
        ...(context.connectionId ? { connection: context.connectionId } : {}),
        ...(params.owner ? { owner: params.owner } : {})
      })
      return { retained }
    }
  })
]
